// Google login + Supabase sync. Optional: without config (or when opened from file://)
// the app still works, saving to this device only.

const Cloud = (() => {
  const cfg = window.APP_CONFIG || {};
  const isHosted = location.protocol === 'http:' || location.protocol === 'https:';
  const configured = Boolean(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY && window.supabase);

  const client = configured
    ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
        db: { schema: 'myexpenses' }, // OneDB: this app's tables live in the "myexpenses" schema
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' },
      })
    : null;

  const PAGE = 500;
  let user = null;
  let running = null;
  const state = { syncing: false, error: null };
  let notify = () => {};

  async function init(onChange) {
    notify = onChange;
    if (!client) return null;
    // Reads the saved session from localStorage, so it also works offline after the first login.
    const { data } = await client.auth.getSession();
    user = data.session?.user ?? null;
    client.auth.onAuthStateChange((_event, session) => {
      const next = session?.user ?? null;
      if (next?.id === user?.id) return;
      user = next;
      notify('auth');
    });
    // Remove ?code=... left behind by the Google redirect.
    if (new URLSearchParams(location.search).has('code')) {
      history.replaceState(null, '', location.pathname);
    }
    return user;
  }

  async function signInWithGoogle() {
    const { error } = await client.auth.signInWithOAuth({
      provider: 'google',
      // Return to this exact page (works for https://<user>.github.io/<repo>/ too).
      options: { redirectTo: location.origin + location.pathname },
    });
    if (error) throw error;
  }

  async function signOut() {
    await client.auth.signOut({ scope: 'local' }); // works offline
    user = null;
  }

  /** Upload unsynced rows, then download rows changed on the server. Concurrent calls share one run. */
  function syncNow() {
    if (!client || !user || !navigator.onLine) return Promise.resolve();
    if (running) return running;
    running = (async () => {
      state.syncing = true;
      state.error = null;
      notify('sync');
      try {
        const pushed = await push(user.id);
        const pulled = await pull(user.id);
        const shared = await reconcileSharedAccess(user.id, user.email);
        if (pushed || pulled || shared) notify('data');
      } catch (e) {
        state.error = e?.message || String(e);
      } finally {
        state.syncing = false;
        running = null;
        notify('sync');
      }
    })();
    return running;
  }

  // Local store ↔ Supabase table. Order matters: lists upload before the members/entries that point at them.
  const listFromServer = (r) => ({ ...r, favorite: Boolean(r.favorite), synced: 1 });
  const entryFromServer = (r) => ({
    ...r,
    amount: Number(r.amount),
    note: r.note || '',
    purpose: r.purpose || '',
    pay_via: r.pay_via || '',
    paid_by: r.paid_by || '',
    spent_time: r.spent_time || '',
    author_name: r.author_name || '',
    direction: r.direction || 'debit',
    synced: 1,
  });
  const TABLES = [
    { store: 'lists', table: 'expense_lists', fromServer: listFromServer },
    { store: 'members', table: 'list_members', fromServer: (r) => ({ ...r, synced: 1 }) },
    { store: 'expenses', table: 'expenses', fromServer: entryFromServer },
  ];

  /**
   * Sharing bookkeeping after a pull:
   *  - newly shared with me → download that list and *all* its entries (they may be older than my sync cursor)
   *  - access removed       → drop my local copy of that list and its entries
   */
  async function reconcileSharedAccess(userId, email) {
    if (!email) return false;
    const me = email.toLowerCase();
    const myMemberships = (await DB.all('members')).filter((m) => m.email === me && m.user_id !== userId);
    const active = new Set(myMemberships.filter((m) => !m.deleted).map((m) => m.list_id));
    const localLists = await DB.all('lists');
    let changed = false;

    const lost = localLists.filter((l) => l.user_id && l.user_id !== userId && !active.has(l.id));
    if (lost.length) {
      const lostIds = new Set(lost.map((l) => l.id));
      for (const l of lost) await DB.delete('lists', l.id);
      for (const e of await DB.all('expenses')) if (lostIds.has(e.list_id)) await DB.delete('expenses', e.id);
      changed = true;
    }

    const have = new Set(localLists.map((l) => l.id));
    const missing = [...active].filter((id) => !have.has(id));
    if (missing.length) {
      const { data: lists, error } = await client.from('expense_lists').select('*').in('id', missing);
      if (error) throw error;
      await DB.putMany('lists', lists.map(listFromServer));
      for (let from = 0; ; from += PAGE) {
        const { data, error: entriesError } = await client
          .from('expenses')
          .select('*')
          .in('list_id', missing)
          .order('id')
          .range(from, from + PAGE - 1);
        if (entriesError) throw entriesError;
        await DB.putMany('expenses', data.map(entryFromServer));
        if (data.length < PAGE) break;
      }
      changed = true;
    }
    return changed;
  }

  async function push(userId) {
    let pushed = false;
    for (const t of TABLES) pushed = (await pushTable(t, userId)) || pushed;
    return pushed;
  }

  async function pull(userId) {
    let pulled = false;
    for (const t of TABLES) pulled = (await pullTable(t, userId)) || pulled;
    return pulled;
  }

  async function pushTable({ store, table, fromServer }, userId) {
    const pending = (await DB.all(store)).filter((r) => r.user_id === userId && r.synced === 0);
    if (pending.length === 0) return false;

    for (let i = 0; i < pending.length; i += PAGE) {
      const batch = pending.slice(i, i + PAGE);
      // The server sets updated_at itself (see schema.sql), so don't send ours.
      const payload = batch.map(({ synced, updated_at, ...row }) => row);
      const { data, error } = await client.from(table).upsert(payload).select();
      if (error) throw error;

      const sentVersion = new Map(batch.map((r) => [r.id, r.updated_at]));
      for (const remote of data || []) {
        const current = await DB.get(store, remote.id);
        // Edited again while uploading? Leave it pending for the next sync.
        if (current && current.updated_at !== sentVersion.get(remote.id)) continue;
        await DB.put(store, fromServer(remote));
      }
    }
    return true;
  }

  async function pullTable({ store, table, fromServer }, userId) {
    const cursorKey = `lastPulledAt:${table}:${userId}`;
    let cursor = (await DB.getMeta(cursorKey)) || '1970-01-01T00:00:00Z';
    let changed = false;

    for (;;) {
      // No user filter: Row Level Security returns my rows plus rows shared with me.
      const { data, error } = await client
        .from(table)
        .select('*')
        .gt('updated_at', cursor)
        .order('updated_at', { ascending: true })
        .limit(PAGE);
      if (error) throw error;
      if (!data.length) break;

      const rows = [];
      for (const remote of data) {
        const local = await DB.get(store, remote.id);
        if (local?.synced === 0) continue; // unsent local edit wins; it uploads next time
        rows.push(fromServer(remote));
      }
      if (rows.length) {
        await DB.putMany(store, rows);
        changed = true;
      }
      cursor = data[data.length - 1].updated_at;
      await DB.setMeta(cursorKey, cursor);
      if (data.length < PAGE) break;
    }
    // Saved even when nothing came back, so the app knows this device has seen the server's data at least once.
    await DB.setMeta(cursorKey, cursor);
    return changed;
  }

  return {
    init,
    signInWithGoogle,
    signOut,
    syncNow,
    state,
    get user() {
      return user;
    },
    configured,
    isHosted,
    canSignIn: configured && isHosted,
  };
})();
