// UI: header (theme + account), home (action cards + quick access), expense lists, entries and forms.
// Screens are switched with the URL hash so it also works from file://:
//   #/                       home
//   #/lists                  all expense lists
//   #/lists/new              create a list          #/lists/edit/<id>          edit a list
//   #/list/<id>              one list's entries
//   #/list/<id>/new          add an entry           #/list/<id>/edit/<entryId> edit an entry
//   #/shared                 lists other people shared with you

(() => {
  const cfg = window.APP_CONFIG || {};
  const LOCALE = cfg.LOCALE || 'en-IN';
  // ₹3,735 for whole amounts, ₹3,394.78 otherwise.
  const moneyWhole = new Intl.NumberFormat(LOCALE, { style: 'currency', currency: cfg.CURRENCY || 'INR', minimumFractionDigits: 0, maximumFractionDigits: 0 });
  const moneyCents = new Intl.NumberFormat(LOCALE, { style: 'currency', currency: cfg.CURRENCY || 'INR' });
  const money = {
    format: (n) => (Math.abs(Math.round(n * 100)) % 100 === 0 ? moneyWhole : moneyCents).format(n),
    formatToParts: (n) => moneyCents.formatToParts(n),
  };
  const THEME_KEY = 'myExpenses.theme';

  // Entry categories (shown in this order). The last two are for money received.
  const CATEGORIES = [
    { id: 'spend', label: 'Spend', icon: '💸' },
    { id: 'bills', label: 'Bills', icon: '💡' },
    { id: 'rent', label: 'Rent / EMI', icon: '🏠' },
    { id: 'food', label: 'Food', icon: '🍔' },
    { id: 'groceries', label: 'Groceries', icon: '🛒' },
    { id: 'health', label: 'Health', icon: '💊' },
    { id: 'personal', label: 'Personal', icon: '💇' },
    { id: 'fuel', label: 'Fuel', icon: '⛽' },
    { id: 'transport', label: 'Transport', icon: '🚌' },
    { id: 'shopping', label: 'Shopping', icon: '🛍️' },
    { id: 'liquor', label: 'Liquor & Smoke', icon: '🍷' },
    { id: 'investment', label: 'Investment', icon: '📈' },
    { id: 'other', label: 'Other', icon: '📦' },
    { id: 'received', label: 'Received', icon: '💰' },
    { id: 'income', label: 'Income', icon: '🏦' },
  ];
  const DEFAULT_SPEND_CATEGORY = 'spend';
  const DEFAULT_RECEIVE_CATEGORY = 'received';
  const RECEIVE_CATEGORIES = ['received', 'income'];
  // Categories from earlier versions: no longer offered, but old entries still show their icon/label.
  const RETIRED_CATEGORIES = [
    { id: 'fun', label: 'Fun', icon: '🎬' },
    { id: 'savings', label: 'Savings', icon: '🏦' },
  ];
  const categoryOf = (id) =>
    CATEGORIES.find((c) => c.id === id) || RETIRED_CATEGORIES.find((c) => c.id === id) || CATEGORIES[0];

  // List types. The first one is the default; unknown/retired types show as the default.
  const KINDS = [
    { id: 'general', label: 'Daily expenses', icon: '📅' },
    { id: 'trip', label: 'Trip / travel', icon: '✈️' },
    { id: 'credit_card', label: 'Credit card', icon: '💳' },
    { id: 'personal', label: 'Personal', icon: '👤' },
    { id: 'home', label: 'Household', icon: '🏠' },
    { id: 'other', label: 'Other', icon: '🗂️' },
  ];
  const kindOf = (id) => KINDS.find((k) => k.id === id) || KINDS[0];

  const $ = (id) => document.getElementById(id);

  let lists = []; // my lists (default first, then oldest → newest)
  let sharedLists = []; // lists other people shared with me
  let members = []; // active sharing rows (for my lists, and my own memberships)
  let entries = []; // visible entries (all lists), newest first
  let notes = []; // visible notes (all lists): rows with kind 'note', kept out of every total
  let stats = new Map(); // list id → { count, last, monthOut, monthIn }
  let pendingCount = 0;
  let view = 'home';
  let currentListId = null;

  // Form state
  let editingEntryId = null;
  let editingNoteId = null;
  let entryFormTab = 'entry'; // entry | note (tabs at the top of the "New" sheet)
  let entryDirection = 'debit';
  let selectedCategory = DEFAULT_SPEND_CATEGORY;
  let editingListId = null;
  let selectedKind = 'general';

  // ---------- helpers ----------

  // Local date as YYYY-MM-DD (not UTC, so late-night entries land on the right day).
  function toISODate(d) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  const todayISO = () => toISODate(new Date());
  const currentMonth = () => todayISO().slice(0, 7);
  const parseISO = (iso) => new Date(`${iso}T00:00:00`);
  const longDate = (iso) => parseISO(iso).toLocaleDateString(LOCALE, { day: '2-digit', month: 'short', year: 'numeric' });
  const monthLabel = () => new Date().toLocaleDateString(LOCALE, { month: 'long', year: 'numeric' });

  const escapeHtml = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const signed = (e) => `${e.direction === 'credit' ? '+' : '−'} ${money.format(e.amount)}`;
  const amountClass = (e) => (e.direction === 'credit' ? 'amount-in' : 'amount-out');

  // ---------- entry fields ----------

  const PAY_VIA = ['Cash', 'UPI', 'Wallet']; // starting list; more can be added / renamed in the form

  // Which pay-via method is cash (it can be renamed). Totals split into cash and balance (everything else).
  const CASH_KEY = 'myExpenses.cashMethod';
  const cashMethod = () => storage((s) => s.getItem(CASH_KEY)) || 'Cash';
  const isCash = (e) => (e.pay_via || '').toLowerCase() === cashMethod().toLowerCase();

  /** Spent / received of some entries, each also counted for cash only. */
  function moneyTotals(rows) {
    const t = { out: 0, inn: 0, outCash: 0, inCash: 0 };
    for (const e of rows) {
      const cash = isCash(e);
      if (e.direction === 'credit') {
        t.inn += e.amount;
        if (cash) t.inCash += e.amount;
      } else {
        t.out += e.amount;
        if (cash) t.outCash += e.amount;
      }
    }
    return t;
  }

  /** "− ₹10", "+ ₹10" or "₹0", coloured by sign. */
  const signedAmount = (n) =>
    `<b class="${n < 0 ? 'amount-out' : n > 0 ? 'amount-in' : 'amount-zero'}">${n < 0 ? '− ' : n > 0 ? '+ ' : ''}${money.format(Math.abs(n))}</b>`;

  // Note rows: a highlighted one-liner in the list that expands to the full text (text only, never money).
  const NOTE_TYPES = [
    { id: 'summary', icon: '📋', label: 'Summary' },
    { id: 'balance', icon: '🏦', label: 'Balance' },
    { id: 'budget', icon: '🎯', label: 'Budget' },
    { id: 'reminder', icon: '⏰', label: 'Reminder' },
    { id: 'due', icon: '🤝', label: 'Due / lent' },
    { id: 'general', icon: '📝', label: 'Note' },
  ];
  const noteTypeOf = (id) => NOTE_TYPES.find((t) => t.id === id) || NOTE_TYPES[NOTE_TYPES.length - 1];
  let selectedNoteType = 'summary';
  const openNoteIds = new Set(); // notes expanded in the list
  const pad2 = (n) => String(n).padStart(2, '0');
  const nowTime = () => {
    const d = new Date();
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  };

  /** 'HH:MM' — saved time, or (older entries) the local time the entry was created. */
  function entryTime(e) {
    if (e.spent_time) return e.spent_time;
    const d = new Date(e.created_at);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  // Older entries kept their description in `note`; newer ones have a separate purpose + optional note.
  const entryPurpose = (e) => e.purpose || e.note || categoryOf(e.category).label;
  const entryNote = (e) => (e.purpose ? e.note : '');
  const firstName = () => myName().split(' ')[0] || 'Me';
  const entryPaidBy = (e) => e.paid_by || (isMine(e) ? firstName() : (e.author_name || '').split(' ')[0] || '—');
  // Expense type of a spent entry ('' = not set).
  const SPEND_TYPES = [
    { id: 'need', icon: '🛒', label: 'Need' },
    { id: 'want', icon: '🛍️', label: 'Want' },
    { id: 'saving', icon: '💰', label: 'Saving' },
  ];
  const spendTypeOf = (e) => (e.direction === 'credit' ? null : SPEND_TYPES.find((t) => t.id === e.spend_type) || null);
  // Your own entries paid by you don't show a name; only someone else's name is worth showing.
  const paidByMe = (e) => isMine(e) && entryPaidBy(e).toLowerCase() === firstName().toLowerCase();

  /** "Mon, 1/02/26" */
  function formatDay(iso) {
    const d = parseISO(iso);
    const weekday = d.toLocaleDateString('en-US', { weekday: 'short' });
    return `${weekday}, ${d.getDate()}/${pad2(d.getMonth() + 1)}/${String(d.getFullYear()).slice(-2)}`;
  }

  /** "10:44AM" */
  function formatTime(time) {
    const [h, m] = time.split(':').map(Number);
    return `${h % 12 || 12}:${pad2(m)}${h >= 12 ? 'PM' : 'AM'}`;
  }

  /** "Mon, 1/02/26 - 10:44AM" */
  const formatWhen = (iso, time) => (time ? `${formatDay(iso)} - ${formatTime(time)}` : formatDay(iso));

  function storage(fn) {
    try {
      return fn(localStorage);
    } catch {
      return null; // storage blocked (private mode etc.)
    }
  }

  let toastTimer;
  function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), 2200);
  }

  // ---------- bottom sheets ----------

  const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  function openSheet(sheet) {
    sheet.classList.remove('closing');
    if (!sheet.open) sheet.showModal();
  }

  /** Slide the sheet down, then close it; `value` becomes sheet.returnValue. */
  function closeSheet(sheet, value = '') {
    if (!sheet.open || sheet.classList.contains('closing')) return;
    if (reducedMotion()) return sheet.close(value);
    sheet.classList.add('closing');
    sheet.addEventListener(
      'animationend',
      () => {
        sheet.classList.remove('closing');
        sheet.close(value);
      },
      { once: true },
    );
  }

  /** Close on Esc, on a tap outside the sheet, and via any [data-close] button inside it. */
  function wireSheet(sheet) {
    sheet.addEventListener('cancel', (e) => {
      e.preventDefault();
      closeSheet(sheet);
    });
    sheet.addEventListener('click', (e) => {
      const r = sheet.getBoundingClientRect();
      const outside = e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
      if (e.target === sheet && outside) closeSheet(sheet);
    });
    for (const b of sheet.querySelectorAll('[data-close]')) b.addEventListener('click', () => closeSheet(sheet, b.dataset.close));
    wireSheetDrag(sheet);
  }

  /**
   * Pull a sheet down to close it. Starts only when nothing under the finger is scrolled
   * (so pulling down still scrolls a long sheet back to its top first).
   */
  function wireSheetDrag(sheet) {
    let drag = null;
    const scrolled = (el) => {
      for (; el && el !== sheet.parentNode; el = el.parentNode) if (el.scrollTop > 0) return true;
      return false;
    };
    const reset = () => { sheet.style.transition = sheet.style.transform = ''; };
    // .dragging switches the open animation off; it stays until the sheet closes, or the open animation would replay.
    sheet.addEventListener('close', () => sheet.classList.remove('dragging', 'drag-closing'));
    sheet.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1 || sheet.classList.contains('closing') || scrolled(e.target)) return;
      drag = { y0: e.touches[0].clientY, t0: Date.now(), dy: 0, active: false };
    }, { passive: true });
    sheet.addEventListener('touchmove', (e) => {
      if (!drag) return;
      const dy = e.touches[0].clientY - drag.y0;
      if (!drag.active) {
        if (dy < -4) { drag = null; return; } // pushing up = normal scrolling
        if (dy < 8) return;
        drag.active = true;
        sheet.classList.add('dragging');
        sheet.style.transition = 'none';
      }
      e.preventDefault();
      drag.dy = Math.max(0, dy - 8);
      sheet.style.transform = `translateY(${drag.dy}px)`;
    }, { passive: false });
    const end = () => {
      if (!drag) return;
      const { dy, t0, active } = drag;
      drag = null;
      if (!active) return;
      const fling = dy > 40 && dy / (Date.now() - t0) > 0.6; // quick flick
      if (dy > sheet.offsetHeight * 0.25 || dy > 140 || fling) {
        if (reducedMotion()) { reset(); return sheet.close(''); }
        sheet.style.transition = 'transform 0.2s ease-in';
        sheet.style.transform = 'translateY(100%)';
        sheet.classList.add('drag-closing');
        setTimeout(() => {
          sheet.close('');
          reset();
        }, 200);
      } else {
        sheet.style.transition = 'transform 0.2s ease';
        sheet.style.transform = '';
        setTimeout(reset, 200);
      }
    };
    sheet.addEventListener('touchend', end);
    sheet.addEventListener('touchcancel', () => { drag = null; reset(); });
  }

  /**
   * Ask (or tell) something in the confirm sheet. Resolves true only when the main button is tapped.
   * Pass cancelText: null for an info message with a single button.
   * `subject` ({ icon, name, meta }) shows what the action is about at the top, in place of `icon`.
   */
  function askSheet({ icon = '⚠️', subject = null, title, message = '', confirmText = 'OK', cancelText = 'Cancel', danger = false }) {
    const sheet = $('confirm-sheet');
    $('confirm-subject').hidden = !subject;
    if (subject) {
      $('confirm-subject-icon').textContent = subject.icon;
      $('confirm-subject-name').textContent = subject.name;
      $('confirm-subject-meta').textContent = subject.meta || '';
      $('confirm-subject-meta').hidden = !subject.meta;
    }
    $('confirm-icon').hidden = Boolean(subject);
    $('confirm-icon').textContent = icon;
    $('confirm-icon').classList.toggle('info', !danger);
    $('confirm-title').textContent = title;
    $('confirm-message').textContent = message;
    $('confirm-message').hidden = !message;
    $('confirm-message').classList.toggle('warning', danger);
    $('confirm-ok').textContent = confirmText;
    $('confirm-ok').className = `btn grow ${danger ? 'btn-danger' : 'btn-gradient'}`;
    const cancel = sheet.querySelector('[data-close="cancel"]');
    cancel.hidden = cancelText === null;
    cancel.textContent = cancelText ?? '';
    sheet.returnValue = '';
    openSheet(sheet);
    return new Promise((resolve) => sheet.addEventListener('close', () => resolve(sheet.returnValue === 'ok'), { once: true }));
  }

  const currentUserId = () => Cloud.user?.id ?? null;
  const myEmail =() => (Cloud.user?.email || '').toLowerCase();
  const myName = () => Cloud.user?.user_metadata?.full_name || Cloud.user?.user_metadata?.name || Cloud.user?.email || '';
  const nowISO = () => new Date().toISOString();

  // ---------- permissions ----------

  const isMine = (row) => (row.user_id ?? null) === currentUserId();
  const findList = (id) => lists.find((l) => l.id === id) || sharedLists.find((l) => l.id === id);
  const listMembers = (listId) => members.filter((m) => m.list_id === listId && m.email !== myEmail());

  /** 'owner' | 'edit' | 'view' | null */
  function roleFor(list) {
    if (isMine(list)) return 'owner';
    return members.find((m) => m.list_id === list.id && m.email === myEmail())?.role ?? null;
  }
  const canAddEntries = (list) => ['owner', 'edit'].includes(roleFor(list));
  const sharedBy = (list) => members.find((m) => m.list_id === list.id && m.email === myEmail())?.owner_name || 'a friend';
  const shortEmail = (email) => email.split('@')[0];

  // ---------- theme ----------

  const systemTheme = () => (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const currentTheme = () => document.documentElement.dataset.theme || systemTheme();

  function renderThemeButton() {
    const dark = currentTheme() === 'dark';
    $('theme-btn').textContent = dark ? '☀️' : '🌙';
    $('theme-btn').title = dark ? 'Switch to light theme' : 'Switch to dark theme';
  }

  function toggleTheme() {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    storage((s) => s.setItem(THEME_KEY, next));
    renderThemeButton();
  }

  // ---------- data ----------

  async function load() {
    const uid = currentUserId();
    // Signed in: the device holds my rows plus rows shared with me (sign-out clears it).
    // Signed out: only rows created while signed out.
    const visible = (r) => (uid ? true : !r.user_id);
    let allLists = (await DB.all('lists')).filter(visible);
    let allEntries = (await DB.all('expenses')).filter(visible);
    const allMembers = (await DB.all('members')).filter(visible);

    const adopted = await adoptOrphanEntries(allLists, allEntries);
    const fixed = await ensureDefaultList(allLists);
    if (adopted || fixed) {
      allLists = (await DB.all('lists')).filter(visible);
      allEntries = (await DB.all('expenses')).filter(visible);
      if (uid) Cloud.syncNow();
    }

    // Only my own rows ever upload, so only they count as "to sync".
    pendingCount = uid ? [...allLists, ...allEntries, ...allMembers].filter((r) => r.synced === 0 && r.user_id === uid).length : 0;
    members = allMembers.filter((m) => !m.deleted);

    const live = allLists.filter((l) => !l.deleted);
    // Mine: default list first, then oldest → newest.
    lists = live.filter(isMine).sort((a, b) => isDefaultList(b) - isDefaultList(a) || a.created_at.localeCompare(b.created_at));
    sharedLists = live.filter((l) => !isMine(l) && roleFor(l)).sort((a, b) => a.name.localeCompare(b.name));

    const listIds = new Set([...lists, ...sharedLists].map((l) => l.id));
    const liveEntries = allEntries
      .filter((e) => !e.deleted && listIds.has(e.list_id))
      .sort(
        (a, b) =>
          b.spent_on.localeCompare(a.spent_on) ||
          entryTime(b).localeCompare(entryTime(a)) ||
          b.created_at.localeCompare(a.created_at),
      );
    // Notes live in the same store (and Supabase table) but are never money, so they're kept apart.
    entries = liveEntries.filter((e) => e.kind !== 'note');
    notes = liveEntries.filter((e) => e.kind === 'note');

    const month = currentMonth();
    stats = new Map([...lists, ...sharedLists].map((l) => [l.id, { count: 0, last: null, monthOut: 0, monthIn: 0 }]));
    for (const e of entries) {
      const s = stats.get(e.list_id);
      s.count++;
      if (!s.last || e.spent_on > s.last) s.last = e.spent_on;
      if (e.spent_on.startsWith(month)) {
        if (e.direction === 'credit') s.monthIn += e.amount;
        else s.monthOut += e.amount;
      }
    }
    renderData();
  }

  // ---------- default list ("My Daily Expenses") ----------
  //
  // Every user always has this list: it can't be deleted, renamed or retyped, and is always in Quick
  // access. Its id is derived from the user id, so every device creates the *same* list and
  // upserts merge instead of duplicating.

  const DEFAULT_LIST = { name: 'My Daily Expenses', kind: 'general', favorite: true };
  const GUEST_DEFAULT_LIST_ID = '00000000-0000-4000-8000-000000000001';

  function defaultListId(uid) {
    if (!uid) return GUEST_DEFAULT_LIST_ID;
    // Reverse the user id's hex digits and set the UUID v4 version/variant nibbles.
    const h = uid.replace(/-/g, '').split('').reverse().join('');
    const v = `${h.slice(0, 12)}4${h.slice(13, 16)}8${h.slice(17, 32)}`;
    return `${v.slice(0, 8)}-${v.slice(8, 12)}-${v.slice(12, 16)}-${v.slice(16, 20)}-${v.slice(20)}`;
  }

  const isDefaultList = (l) => isMine(l) && l.id === defaultListId(currentUserId());

  /** Create the default list if missing, and undo a delete/unfavourite (e.g. from an older version). */
  async function ensureDefaultList(allLists) {
    const uid = currentUserId();
    // Signed in: wait until this device has downloaded the account's lists, so a rename made on
    // another device isn't overwritten by a freshly created copy.
    if (uid && !(await DB.getMeta(`lastPulledAt:expense_lists:${uid}`))) return false;
    const id = defaultListId(uid);
    const row = allLists.find((l) => l.id === id);
    if (!row) {
      await DB.put('lists', newListRow({ id, ...DEFAULT_LIST }, uid));
      return true;
    }
    // Undo any change made by an older version (rename, retype, delete, unfavourite).
    const intact = !row.deleted && row.favorite && row.name === DEFAULT_LIST.name && row.kind === DEFAULT_LIST.kind;
    if (!intact) {
      await DB.put('lists', { ...row, ...DEFAULT_LIST, deleted: false, updated_at: nowISO(), synced: 0 });
      return true;
    }
    return false;
  }

  /** Entries saved before lists existed get moved into the default list. */
  async function adoptOrphanEntries(allLists, allEntries) {
    const orphans = allEntries.filter((e) => !e.list_id);
    if (!orphans.length) return false;
    const owner = orphans[0].user_id ?? null;
    const targetId = defaultListId(owner);
    if (!allLists.some((l) => l.id === targetId)) await DB.put('lists', newListRow({ id: targetId, ...DEFAULT_LIST }, owner));
    const now = nowISO();
    await DB.putMany(
      'expenses',
      orphans.map((e) => ({ ...e, list_id: targetId, direction: e.direction || 'debit', updated_at: now, synced: 0 })),
    );
    return true;
  }

  /** After signing in, attach rows created while signed out to the account so they upload. */
  async function claimGuestRows(uid) {
    const now = nowISO();
    const userDefaultId = defaultListId(uid);
    const guestLists = (await DB.all('lists')).filter((r) => !r.user_id);
    const guestEntries = (await DB.all('expenses')).filter((r) => !r.user_id);

    // Guest rows deleted before signing in were never uploaded: just drop them.
    for (const r of guestLists.filter((r) => r.deleted)) await DB.delete('lists', r.id);
    for (const r of guestEntries.filter((r) => r.deleted)) await DB.delete('expenses', r.id);

    const lists = [];
    for (const l of guestLists.filter((r) => !r.deleted)) {
      if (l.id !== GUEST_DEFAULT_LIST_ID) {
        lists.push({ ...l, user_id: uid, updated_at: now, synced: 0 });
        continue;
      }
      // The guest's default list becomes the account's default list. If it was never touched,
      // drop it and let the account's own copy (from the server, or created after first sync) be used.
      await DB.delete('lists', l.id);
      const used = l.updated_at !== l.created_at || guestEntries.some((e) => !e.deleted && e.list_id === l.id);
      if (used) lists.push({ ...l, id: userDefaultId, user_id: uid, updated_at: now, synced: 0 });
    }
    await DB.putMany('lists', lists);
    await DB.putMany(
      'expenses',
      guestEntries
        .filter((e) => !e.deleted)
        .map((e) => ({
          ...e,
          user_id: uid,
          list_id: e.list_id === GUEST_DEFAULT_LIST_ID ? userDefaultId : e.list_id,
          updated_at: now,
          synced: 0,
        })),
    );
  }

  async function afterWrite() {
    await load();
    Cloud.syncNow();
  }

  function newListRow(input, userId = currentUserId()) {
    const now = nowISO();
    return { id: newId(), user_id: userId, favorite: false, ...input, created_at: now, updated_at: now, deleted: false, synced: 0 };
  }

  async function addList(input) {
    const row = newListRow(input);
    await DB.put('lists', row);
    await afterWrite();
    return row;
  }

  async function updateRow(store, id, patch) {
    const row = await DB.get(store, id);
    if (!row) return;
    await DB.put(store, { ...row, ...patch, updated_at: nowISO(), synced: 0 });
    await afterWrite();
  }

  async function deleteList(id) {
    // Soft delete the list and its entries so other devices learn about it when they sync.
    const now = nowISO();
    const list = await DB.get('lists', id);
    // Only my own entries can be changed (friends' entries disappear with the list); sharing is revoked too.
    const mark = (rows) => rows.filter((r) => r.list_id === id && !r.deleted && isMine(r)).map((r) => ({ ...r, deleted: true, updated_at: now, synced: 0 }));
    await DB.putMany('expenses', mark(await DB.all('expenses')));
    await DB.putMany('members', mark(await DB.all('members')));
    await DB.put('lists', { ...list, deleted: true, updated_at: now, synced: 0 });
    await afterWrite();
  }

  async function addEntry(input) {
    const now = nowISO();
    await DB.put('expenses', {
      id: newId(),
      user_id: currentUserId(),
      author_name: myName(),
      ...input,
      created_at: now,
      updated_at: now,
      deleted: false,
      favorite: false,
      synced: 0,
    });
    await afterWrite();
  }

  // ---------- sharing ----------

  let sharingListId = null;

  function openShareDialog(listId) {
    sharingListId = listId;
    $('share-email').value = '';
    $('share-role').value = 'view';
    setError('share-error', '');
    renderShareDialog();
    openSheet($('share-dialog'));
    if (Cloud.user) $('share-email').focus();
  }

  function renderShareDialog() {
    const list = findList(sharingListId);
    if (!list) return;
    $('share-title').textContent = `Share "${list.name}"`;

    // Signed out: explain why sign-in is needed (and offer it when possible).
    const signedIn = Boolean(Cloud.user);
    $('share-signed-in').hidden = !signedIn;
    $('share-signed-out').hidden = signedIn;
    if (!signedIn) {
      $('share-signin').hidden = !Cloud.canSignIn;
      return;
    }
    const people = listMembers(list.id);
    $('share-members').innerHTML = people.length
      ? people
          .map(
            (m) => `
          <li class="member">
            <span class="member-avatar" aria-hidden="true">${escapeHtml(m.email.charAt(0).toUpperCase())}</span>
            <span class="member-email" title="${escapeHtml(m.email)}">${escapeHtml(m.email)}</span>
            <select class="member-role" data-member="${m.id}" aria-label="Access for ${escapeHtml(m.email)}">
              <option value="view" ${m.role === 'view' ? 'selected' : ''}>👁 View</option>
              <option value="edit" ${m.role === 'edit' ? 'selected' : ''}>✏️ Edit</option>
            </select>
            <button class="icon-btn" type="button" data-remove-member="${m.id}" aria-label="Remove ${escapeHtml(m.email)}">✕</button>
          </li>`,
          )
          .join('')
      : '<li class="muted small member-empty">Not shared with anyone yet.</li>';
  }

  async function onShareSubmit(event) {
    event.preventDefault();
    const email = $('share-email').value.trim().toLowerCase();
    const role = $('share-role').value;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return setError('share-error', 'Enter a valid email address');
    if (email === myEmail()) return setError('share-error', "That's you 🙂 Enter a friend's email");
    setError('share-error', '');

    // One row per (list, email) on the server, so re-sharing reuses the old (removed) row.
    const existing = (await DB.all('members')).find((m) => m.list_id === sharingListId && m.email === email);
    if (existing) {
      await DB.put('members', { ...existing, role, deleted: false, owner_name: myName(), updated_at: nowISO(), synced: 0 });
    } else {
      const now = nowISO();
      await DB.put('members', {
        id: newId(),
        user_id: currentUserId(),
        list_id: sharingListId,
        email,
        role,
        owner_name: myName(),
        created_at: now,
        updated_at: now,
        deleted: false,
        synced: 0,
      });
    }
    await afterWrite();
    $('share-email').value = '';
    renderShareDialog();
    toast(`Shared with ${shortEmail(email)} (${role === 'edit' ? 'can edit' : 'view only'})`);
  }

  async function onShareMembersClick(event) {
    const btn = event.target.closest('[data-remove-member]');
    if (!btn) return;
    const m = members.find((x) => x.id === btn.dataset.removeMember);
    if (!m) return;
    const ok = await askSheet({
      subject: { icon: '👤', name: m.email, meta: m.role === 'edit' ? '✏️ Can edit' : '👁 View only' },
      title: 'Are you sure you want to stop sharing with them?',
      message: `⚠️ They will lose access to "${findList(m.list_id)?.name ?? 'this list'}".`,
      confirmText: 'Remove',
      danger: true,
    });
    if (!ok) return;
    await updateRow('members', m.id, { deleted: true });
    renderShareDialog();
    toast(`Removed ${shortEmail(m.email)}`);
  }

  async function onShareRoleChange(event) {
    const select = event.target.closest('[data-member]');
    if (!select) return;
    await updateRow('members', select.dataset.member, { role: select.value });
    renderShareDialog();
    toast(select.value === 'edit' ? 'They can now add entries' : 'Now view only');
  }

  async function copyListLink() {
    const url = `${location.href.split('#')[0]}#/list/${sharingListId}`;
    try {
      await navigator.clipboard.writeText(url);
      toast('🔗 Link copied. Only people you shared with can open it.');
    } catch {
      prompt('Copy this link:', url); // clipboard blocked
    }
  }

  // ---------- header ----------

  function setHeader({ compact, title = '', back = '#/' }) {
    $('hero').classList.toggle('compact', compact);
    $('page-title').textContent = title;
    $('hero-back').href = back;
    document.title = compact && title ? `${title} · Expense Manager` : 'Expense Manager';
  }

  function renderAccount() {
    const user = Cloud.user;
    $('signin-btn').hidden = Boolean(user);
    $('user-info').hidden = !user;
    if (!user) return;
    const name = user.user_metadata?.full_name || user.user_metadata?.name || user.email || '';
    const avatar = user.user_metadata?.avatar_url || user.user_metadata?.picture;
    $('user-name').textContent = name;
    $('user-info').title = user.email || name;
    $('user-avatar').innerHTML = avatar
      ? `<img src="${escapeHtml(avatar)}" alt="" referrerpolicy="no-referrer" />`
      : escapeHtml(name.charAt(0).toUpperCase());
  }

  function renderStatus() {
    let text;
    if (!Cloud.user) text = navigator.onLine ? '💾 Saved on this device' : '📴 Offline · saved on this device';
    else if (!navigator.onLine) text = pendingCount ? `📴 Offline · ${pendingCount} to sync` : '📴 Offline';
    else if (Cloud.state.error) text = '⚠️ Sync failed';
    else if (Cloud.state.syncing) text = '🔄 Syncing…';
    else if (pendingCount) text = `🔄 ${pendingCount} to sync`;
    else text = '☁️ All synced';
    const el = $('status');
    el.textContent = text;
    el.title = Cloud.state.error || '';
    el.className = `status ${Cloud.user && Cloud.state.error ? 'status-error' : ''}`;

    const dot = $('online-dot');
    dot.classList.toggle('is-online', navigator.onLine);
    dot.title = navigator.onLine ? 'Online' : 'Offline';
  }

  const info = (title, message) => askSheet({ icon: 'ℹ️', title, message, confirmText: 'OK', cancelText: null });

  async function onSignInClick() {
    if (!Cloud.isHosted) {
      return info(
        'Sign-in needs a web address',
        'Google sign-in works when the app is opened from http://localhost:3000 or GitHub Pages, not when index.html is opened as a file. Your expenses are still saved on this device.',
      );
    }
    if (!Cloud.configured) return info('Sign-in not set up', 'Add your Supabase URL and anon key in config.js to enable Google sign-in.');
    if (!navigator.onLine) return info("You're offline", 'Connect to the internet to sign in.');
    $('signin-btn').disabled = true;
    try {
      await Cloud.signInWithGoogle(); // navigates away to Google
    } catch (e) {
      info('Sign-in failed', e?.message || String(e));
      $('signin-btn').disabled = false;
    }
  }

  function openProfileSheet() {
    const user = Cloud.user;
    if (!user) return;
    const name = user.user_metadata?.full_name || user.user_metadata?.name || user.email || '';
    const avatar = user.user_metadata?.avatar_url || user.user_metadata?.picture;
    $('profile-avatar').innerHTML = avatar
      ? `<img src="${escapeHtml(avatar)}" alt="" referrerpolicy="no-referrer" />`
      : escapeHtml(name.charAt(0).toUpperCase());
    $('profile-name').textContent = name;
    $('profile-email').textContent = user.email && user.email !== name ? user.email : '';
    $('profile-badge').textContent = `Signed in with Google · ${lists.length} ${lists.length === 1 ? 'list' : 'lists'}`;
    openSheet($('profile-sheet'));
  }

  async function onProfileLogout() {
    closeSheet($('profile-sheet'));
    // Unsynced changes would be lost: say so first. Otherwise Log out here is the confirmation.
    if (pendingCount) return onLogoutClick();
    await signOut();
  }

  async function onLogoutClick() {
    const ok = await askSheet({
      icon: '👋',
      title: 'Sign out?',
      message: pendingCount
        ? `${pendingCount} change(s) haven't synced yet and will be lost.`
        : 'Your expenses stay safe in the cloud and will be removed from this device.',
      confirmText: 'Sign out',
      danger: pendingCount > 0,
    });
    if (!ok) return;
    await signOut();
  }

  async function signOut() {
    await DB.clearAll();
    await Cloud.signOut();
    renderAccount();
    await load();
    location.hash = '#/';
    toast('Signed out');
  }

  // ---------- install (PWA) ----------

  let installPrompt = null; // Chrome/Edge/Android hand us this when the app can be installed in one tap
  let installed = false;
  const ua = navigator.userAgent;
  const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  // iPadOS reports itself as a Mac, so also check for touch.
  const isIOS = () => /iphone|ipad|ipod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const isAndroid = () => /android/i.test(ua);

  function renderInstall() {
    $('install-btn').hidden = installed || isStandalone();
  }

  async function onInstallClick() {
    if (installPrompt) {
      // Direct install: the browser shows its own "Install app?" confirmation.
      installPrompt.prompt();
      const { outcome } = await installPrompt.userChoice;
      installPrompt = null; // a prompt can only be used once
      if (outcome === 'accepted') installed = true;
      renderInstall();
      return;
    }
    showInstallHelp();
  }

  /** The browser didn't offer one-tap install, so explain how to do it for this browser. */
  function showInstallHelp() {
    let html;
    if (!Cloud.isHosted) {
      html = `
        <p>Apps can't be installed from a file opened on disk. Open the app from a web address instead:</p>
        <ol>
          <li>Run <code>node server.js</code> in the project folder</li>
          <li>Open <code>http://localhost:3000</code> in Chrome or Edge</li>
          <li>Tap <b>Install app</b> again</li>
        </ol>
        <p class="muted">On your phone, use the GitHub Pages link.</p>`;
    } else if (isIOS()) {
      html = `
        <ol>
          <li>Tap the <b>Share</b> button (square with an arrow) in Safari</li>
          <li>Scroll down and tap <b>Add to Home Screen</b></li>
          <li>Tap <b>Add</b></li>
        </ol>`;
    } else if (isAndroid()) {
      html = `
        <ol>
          <li>Open the browser menu <b>⋮</b> (top right)</li>
          <li>Tap <b>Install app</b> or <b>Add to Home screen</b></li>
          <li>Confirm with <b>Install</b></li>
        </ol>`;
    } else if (/Edg\//.test(ua)) {
      html = `
        <ol>
          <li>Click the <b>App available</b> icon in the address bar, <b>or</b></li>
          <li>Open the menu <b>⋯</b> → <b>Apps</b> → <b>Install this site as an app</b></li>
        </ol>`;
    } else if (/Chrome\//.test(ua)) {
      html = `
        <ol>
          <li>Click the <b>Install</b> icon at the right end of the address bar, <b>or</b></li>
          <li>Open the menu <b>⋮</b> → <b>Cast, save and share</b> → <b>Install page as app…</b></li>
        </ol>`;
    } else if (/Safari\//.test(ua) && !/Chrome|Firefox/.test(ua)) {
      html = `<ol><li>In the menu bar choose <b>File</b> → <b>Add to Dock…</b></li></ol>`;
    } else {
      html = `<p>This browser can't install web apps. Open the app in <b>Chrome</b> or <b>Edge</b> and tap <b>Install app</b> again.</p>`;
    }
    if (Cloud.isHosted) {
      html += '<p class="muted">Already installed? Look for <b>Expense Manager</b> on your home screen or in your apps.</p>';
    }
    $('install-steps').innerHTML = html;
    openSheet($('install-dialog'));
  }

  // ---------- home ----------

  function renderHome() {
    let myMonthOut = 0;
    for (const l of lists) myMonthOut += stats.get(l.id).monthOut;
    $('home-lists').textContent = lists.length
      ? `${lists.length} ${lists.length === 1 ? 'list' : 'lists'} · ${monthLabel()}: − ${money.format(myMonthOut)}`
      : 'No lists yet';
    $('home-shared').textContent = sharedLists.length
      ? `${sharedLists.length} ${sharedLists.length === 1 ? 'list' : 'lists'} shared with you`
      : Cloud.user
        ? 'Nothing shared yet'
        : 'Sign in to see lists shared with you';

    const favorites = lists.filter((l) => l.favorite);
    $('favorites').innerHTML = favorites.length
      ? `<div class="quick-grid">${favorites
          .map((l) => {
            const k = kindOf(l.kind);
            const s = stats.get(l.id);
            return `
            <div class="quick-card ${isDefaultList(l) ? 'is-default' : ''}">
              <a class="quick-main" href="#/list/${l.id}">
                <span class="quick-icon" aria-hidden="true">${k.icon}</span>
                <span class="quick-text">
                  <span class="quick-title">${escapeHtml(l.name)}</span>
                  <span class="quick-sub">${k.label} · this month − ${money.format(s.monthOut)}</span>
                </span>
              </a>
              ${heartButton(l)}
            </div>`;
          })
          .join('')}</div>`
      : `<p class="empty muted">Nothing here yet.<br />Tap ♡ on any list in <a href="#/lists">View Your Expenses</a> to add it to quick access.</p>`;
  }

  // ---------- lists ----------

  const shareIcon =
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="18" cy="5" r="3" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="6" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="18" cy="19" r="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4" stroke="currentColor" stroke-width="2"/></svg>';

  const roleIcon = (role) => (role === 'edit' ? '✏️' : '👁');

  /** "N entries · last entry …" and "October 2026: − ₹x · + ₹y" lines shared by list cards. */
  function listSummaryLines(l) {
    const s = stats.get(l.id);
    const entriesLine = s.count ? `${s.count} ${s.count === 1 ? 'entry' : 'entries'} · last entry ${longDate(s.last)}` : 'No entries yet';
    return `
      <span class="muted">${entriesLine}</span>
      <span class="muted">${monthLabel()}: <span class="amount-out">− ${money.format(s.monthOut)}</span> · <span class="amount-in">+ ${money.format(s.monthIn)}</span></span>`;
  }

  /** Heart toggle; the default list's heart is fixed on. */
  function heartButton(l) {
    if (isDefaultList(l)) {
      return '<span class="icon-btn heart is-on locked" title="Always in quick access" aria-label="Always in quick access">♥</span>';
    }
    return `<button class="icon-btn heart ${l.favorite ? 'is-on' : ''}" type="button" data-action="fav-list" data-id="${l.id}"
      aria-label="${l.favorite ? 'Remove from quick access' : 'Add to quick access'}">${l.favorite ? '♥' : '♡'}</button>`;
  }

  function renderLists() {
    $('lists-count').textContent = `${lists.length} ${lists.length === 1 ? 'list' : 'lists'}`;
    if (!lists.length) {
      $('lists').innerHTML = `
        <div class="card empty-card">
          <span class="empty-icon" aria-hidden="true">📋</span>
          <strong>No expense lists yet</strong>
          <p class="muted">Create a list like "Monthly Expenses" or "Credit Card", then add entries to it.</p>
          <a href="#/lists/new" class="btn btn-gradient btn-sm">+ Create your first list</a>
        </div>`;
      return;
    }
    $('lists').innerHTML = lists
      .map((l) => {
        const k = kindOf(l.kind);
        const people = listMembers(l.id);
        const badges =
          (isDefaultList(l) ? ' <span class="badge">default</span>' : '') +
          (people.length ? ' <span class="badge">shared by you</span>' : '');
        const sharedLine = people.length
          ? `<span class="muted shared-line">Shared with ${people
              .map((m) => `${escapeHtml(shortEmail(m.email))} <span title="${m.role === 'edit' ? 'can edit' : 'view only'}">${roleIcon(m.role)}</span>`)
              .join(', ')}</span>`
          : '';
        return `
        <article class="card list-card ${isDefaultList(l) ? 'is-default' : ''}">
          <a class="list-card-main" href="#/list/${l.id}">
            <span class="list-card-head">
              <span class="list-card-icon" aria-hidden="true">${k.icon}</span>
              <span class="list-card-name">${escapeHtml(l.name)}${badges}</span>
            </span>
            ${sharedLine}
            ${listSummaryLines(l)}
          </a>
          <div class="list-card-actions">
            ${heartButton(l)}
            <span class="grow"></span>
            <button class="tool-btn" type="button" data-action="share-list" data-id="${l.id}" aria-label="Share with friends" title="Share with friends">${shareIcon}</button>
            ${
              isDefaultList(l) // fixed name/type and can't be deleted
                ? ''
                : `<button class="tool-btn" type="button" data-action="edit-list" data-id="${l.id}" aria-label="Edit list" title="Edit">✏️</button>
            <button class="tool-btn tool-danger" type="button" data-action="delete-list" data-id="${l.id}" aria-label="Delete list" title="Delete">🗑️</button>`
            }
          </div>
        </article>`;
      })
      .join('');
  }

  // ---------- shared with me ----------

  function renderShared() {
    if (!sharedLists.length) {
      const msg = Cloud.user
        ? `Nothing shared with you yet.<br />When a friend shares a list with <b>${escapeHtml(myEmail())}</b>, it shows up here.`
        : 'Sign in with Google to see lists your friends shared with you.';
      $('shared').innerHTML = `
        <div class="card empty-card">
          <span class="empty-icon" aria-hidden="true">👥</span>
          <strong>Shared with you</strong>
          <p class="muted">${msg}</p>
        </div>`;
      return;
    }
    $('shared').innerHTML = sharedLists
      .map((l) => {
        const role = roleFor(l);
        return `
        <article class="card list-card">
          <a class="list-card-main list-card-main-last" href="#/list/${l.id}">
            <span class="list-card-head">
              <span class="list-card-icon" aria-hidden="true">${kindOf(l.kind).icon}</span>
              <span class="list-card-name">${escapeHtml(l.name)} <span class="badge">${roleIcon(role)} ${role === 'edit' ? 'can edit' : 'view only'}</span></span>
            </span>
            <span class="muted shared-line">👥 Shared by ${escapeHtml(sharedBy(l))}</span>
            ${listSummaryLines(l)}
          </a>
        </article>`;
      })
      .join('');
  }

  // ---------- one list ----------

  const selectedMonthByList = new Map(); // list id → 'YYYY-MM' being shown (defaults to this month)
  let monthCounts = new Map(); // 'YYYY-MM' → number of entries in the current list

  /** 'YYYY-MM' → "Oct 26" */
  function shortMonth(ym) {
    const [y, m] = ym.split('-').map(Number);
    return `${new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'short' })} ${String(y).slice(-2)}`;
  }

  /** 'YYYY-MM' plus/minus n months. */
  function addMonths(ym, n) {
    const [y, m] = ym.split('-').map(Number);
    const d = new Date(y, m - 1 + n, 1);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
  }

  const shownMonth = () => selectedMonthByList.get(currentListId) || currentMonth();

  function showMonth(month) {
    // Choosing a month shows that month: the long list switches to month view (calendar stays calendar).
    if (viewMode === 'all') {
      viewMode = 'month';
      storage((st) => st.setItem(VIEW_KEY, viewMode));
    }
    selectedMonthByList.set(currentListId, month);
    selectedEntryIds.clear();
    renderListDetail();
  }

  // ---------- search & filter (applies to the month being viewed) ----------

  const emptyFilters = () => ({ type: 'all', via: new Set(), stypes: new Set(), by: new Set(), cats: new Set(), text: '' });
  const copyFilters = (f) => ({ type: f.type, via: new Set(f.via), stypes: new Set(f.stypes), by: new Set(f.by), cats: new Set(f.cats), text: f.text });
  let filters = emptyFilters(); // applied
  let draftFilters = emptyFilters(); // being edited in the sheet

  const activeFilterCount = (f) => (f.type !== 'all') + f.via.size + f.stypes.size + f.by.size + f.cats.size + (f.text.trim() ? 1 : 0);

  function matchesFilters(e, f) {
    if (f.type === 'spent' && e.direction === 'credit') return false;
    if (f.type === 'received' && e.direction !== 'credit') return false;
    if (f.via.size) {
      const via = (e.pay_via || '').toLowerCase(); // "Credit card" and "Credit Card" are the same method
      if (![...f.via].some((v) => v.toLowerCase() === via)) return false;
    }
    if (f.stypes.size && !f.stypes.has(spendTypeOf(e)?.id)) return false;
    if (f.by.size) {
      const by = entryPaidBy(e).toLowerCase();
      if (![...f.by].some((n) => n.toLowerCase() === by)) return false;
    }
    if (f.cats.size && !f.cats.has(e.category)) return false;
    const words = f.text.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length) {
      const haystack = [entryPurpose(e), entryNote(e), e.pay_via, entryPaidBy(e), categoryOf(e.category).label, spendTypeOf(e)?.label, String(e.amount), money.format(e.amount)]
        .join(' ')
        .toLowerCase();
      if (!words.every((w) => haystack.includes(w))) return false;
    }
    return true;
  }

  /** Entries the list page is showing before filters: one month, or every month in long-list view. */
  // The period on screen: the shown month (month / calendar view), its year (year view), or everything (long list).
  const periodEntries = () => {
    const period = viewMode === 'all' ? '' : viewMode === 'year' || chartByYear() ? shownMonth().slice(0, 4) : shownMonth();
    return entries.filter((e) => e.list_id === currentListId && e.spent_on.startsWith(period));
  };

  function openFilterSheet() {
    draftFilters = copyFilters(filters);
    $('f-text').value = draftFilters.text;
    renderFilterSheet();
    openSheet($('filter-sheet'));
    // Focus the selected Type pill ("All" by default), not the search box, so the phone keyboard stays closed.
    $('f-type').querySelector('.is-on')?.focus({ preventScroll: true });
  }

  /** Pay-via options in three groups: cash & bank first, then UPI / wallets / others, then cards. */
  function groupPayMethods(methods) {
    const groups = [
      { label: '💵 Cash & bank', items: [] },
      { label: '📱 UPI & wallets', items: [] },
      { label: '💳 Cards', items: [] },
    ];
    for (const m of methods) {
      if (/\bcard\b/i.test(m)) groups[2].items.push(m);
      else if (/cash|bank|neft|imps|rtgs|cheque|check/i.test(m)) groups[0].items.push(m);
      else groups[1].items.push(m);
    }
    const isOther = (m) => /^other$/i.test(m);
    for (const g of groups) g.items.sort((a, b) => isOther(a) - isOther(b) || a.localeCompare(b, undefined, { sensitivity: 'base' }));
    return groups.filter((g) => g.items.length);
  }

  function renderFilterSheet() {
    const pill = (attr, value, label, on) =>
      `<button type="button" class="pill ${on ? 'is-on' : ''}" ${attr}="${escapeHtml(value)}" aria-pressed="${on}">${label}</button>`;
    // Counts and totals: entries in the period on screen (month / year / everything, as the view shows).
    const inPeriod = periodEntries().filter((e) => e.kind !== 'note');
    /** Spent / received per option (key → { out, inn }). */
    const sums = (keyOf) => {
      const m = new Map();
      for (const e of inPeriod) {
        const k = keyOf(e);
        if (!k) continue;
        const s = m.get(k) || { out: 0, inn: 0 };
        if (e.direction === 'credit') s.inn += e.amount;
        else s.out += e.amount;
        m.set(k, s);
      }
      return m;
    };
    /** "+ ₹1,000 − ₹300" (only the non-zero sides). */
    const sumHtml = (s, fmt = money.format) =>
      s ? `${s.inn ? `<b class="amount-in">+ ${fmt(s.inn)}</b>` : ''}${s.out ? `<b class="amount-out">− ${fmt(s.out)}</b>` : ''}` : '';

    const all = moneyTotals(inPeriod);
    $('f-type').innerHTML = [
      ['all', 'All', all.inn - all.out],
      ['spent', '− Spent', -all.out],
      ['received', '+ Received', all.inn],
    ]
      .map(([v, label, total]) =>
        pill('data-f-type', v, `${label}<span class="pill-sum">${signedAmount(total)}</span>`, draftFilters.type === v).replace('class="pill', `class="pill type-${v}`),
      )
      .join('');

    // Your payment methods, plus any older value still used by entries in this list.
    const used = entries.filter((e) => e.list_id === currentListId && e.pay_via).map((e) => e.pay_via);
    // One pill per method, whatever its capitals; your own spelling (from the Pay via list) wins.
    const byKey = new Map();
    for (const m of [...getOptions('pay'), ...used]) if (!byKey.has(m.toLowerCase())) byKey.set(m.toLowerCase(), m);
    const methods = [...byKey.values()];
    const viaCount = new Map();
    for (const e of inPeriod) if (e.pay_via) viaCount.set(e.pay_via.toLowerCase(), (viaCount.get(e.pay_via.toLowerCase()) || 0) + 1);
    const viaSum = sums((e) => e.pay_via?.toLowerCase());
    // One method per line, grouped: ☐ name ……… + received − spent · entries
    $('f-via').innerHTML = groupPayMethods(methods)
      .map(
        (g) => `<div class="via-group">
          <span class="via-group-label">${g.label}</span>
          <div class="via-list">${g.items
            .map((v) => {
              const on = draftFilters.via.has(v);
              const n = viaCount.get(v.toLowerCase()) || 0;
              return `<button type="button" class="via-row ${on ? 'is-on' : ''}" data-f-via="${escapeHtml(v)}" aria-pressed="${on}">
                <span class="via-check" aria-hidden="true">${on ? '✓' : ''}</span>
                <span class="via-name">${escapeHtml(v)}</span>
                <span class="via-sum">${sumHtml(viaSum.get(v.toLowerCase()))}</span>
                <span class="via-count">${n || ''}</span>
              </button>`;
            })
            .join('')}</div>
        </div>`,
      )
      .join('');

    // Expense type: Need / Want / Saving with the count and spent total in the period.
    const stypeCount = new Map();
    for (const e of inPeriod) {
      const t = spendTypeOf(e);
      if (t) stypeCount.set(t.id, (stypeCount.get(t.id) || 0) + 1);
    }
    const stypeSum = sums((e) => spendTypeOf(e)?.id);
    $('f-stype').innerHTML = SPEND_TYPES.map((t) => {
      const on = draftFilters.stypes.has(t.id);
      const count = stypeCount.get(t.id) || 0;
      const sum = sumHtml(stypeSum.get(t.id));
      return `<button type="button" class="pill stype-${t.id} ${on ? 'is-on' : ''}" data-f-stype="${t.id}" aria-pressed="${on}">${t.icon} ${t.label}${count ? ` <span class="pill-count">${count}</span>` : ''}${sum ? `<span class="pill-sum">${sum}</span>` : ''}</button>`;
    }).join('');

    // Paid by: the names on this list's entries (plus your saved names), most used in the period first.
    const byCount = new Map(); // lower-case name → [name, count in period]
    const inPeriodSet = new Set(inPeriod);
    for (const e of entries) {
      if (e.list_id !== currentListId || e.kind === 'note') continue;
      const n = entryPaidBy(e);
      if (!n || n === '—') continue;
      const k = n.toLowerCase();
      byCount.set(k, [byCount.get(k)?.[0] || n, (byCount.get(k)?.[1] || 0) + (inPeriodSet.has(e) ? 1 : 0)]);
    }
    for (const n of getOptions('people')) if (!byCount.has(n.toLowerCase())) byCount.set(n.toLowerCase(), [n, 0]);
    const people = [...byCount.values()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], undefined, { sensitivity: 'base' }));
    const bySum = sums((e) => { const n = entryPaidBy(e); return n === '—' ? '' : n.toLowerCase(); });
    $('f-by').innerHTML = people.length
      ? people
          .map(([n, count]) => {
            const on = [...draftFilters.by].some((x) => x.toLowerCase() === n.toLowerCase());
            const sum = sumHtml(bySum.get(n.toLowerCase()));
            return `<button type="button" class="pill ${on ? 'is-on' : ''}" data-f-by="${escapeHtml(n)}" aria-pressed="${on}">${escapeHtml(n)}${count ? ` <span class="pill-count">${count}</span>` : ''}${sum ? `<span class="pill-sum">${sum}</span>` : ''}</button>`;
          })
          .join('')
      : '<span class="muted small">No names yet.</span>';
    // Only you so far: nothing to filter by, so hide "Paid by" until someone else's name shows up.
    $('f-by').closest('.field').hidden = people.length < 2;

    const usedCats = new Set(entries.filter((e) => e.list_id === currentListId).map((e) => e.category));
    const cats = [...CATEGORIES, ...RETIRED_CATEGORIES.filter((c) => usedCats.has(c.id))];
    // Entries per category in the month being shown (whole list in "All" view).
    const catCount = new Map();
    for (const e of inPeriod) catCount.set(e.category, (catCount.get(e.category) || 0) + 1);
    const catSum = sums((e) => e.category);
    // Same category chips as the entry form (here you can pick several), with the total underneath (whole rupees to fit).
    $('f-cats').innerHTML = cats
      .map((c) => {
        const on = draftFilters.cats.has(c.id);
        const n = catCount.get(c.id) || 0;
        const sum = sumHtml(catSum.get(c.id), (x) => moneyWhole.format(x));
        return `<button type="button" data-f-cat="${c.id}" aria-label="${c.label}${n ? `, ${n} entries` : ''}" aria-pressed="${on}" class="chip ${on ? 'chip-active' : ''}">
          ${n ? `<span class="chip-count" aria-hidden="true">${n}</span>` : ''}<span class="chip-icon" aria-hidden="true">${c.icon}</span>${chipLabel(c.label)}${sum ? `<span class="chip-sum">${sum}</span>` : ''}</button>`;
      })
      .join('');
    updateFilterCount();
  }

  function updateFilterCount() {
    const matching = periodEntries().filter((e) => matchesFilters(e, draftFilters));
    const n = matching.length;
    $('f-apply').textContent = `Show ${n} ${n === 1 ? 'entry' : 'entries'}`;

    // EXPERIMENT (easy to remove: this block + #f-totals in index.html + .f-totals CSS):
    // totals of the entries that match the current filters.
    let out = 0;
    let inn = 0;
    for (const e of matching) {
      if (e.direction === 'credit') inn += e.amount;
      else out += e.amount;
    }
    const net = inn - out;
    $('f-totals').innerHTML = `
      <span>Spent <b class="amount-out">− ${money.format(out)}</b></span>
      <span>Received <b class="amount-in">+ ${money.format(inn)}</b></span>
      <span>Net <b class="${net < 0 ? 'amount-out' : 'amount-in'}">${net < 0 ? '−' : '+'} ${money.format(Math.abs(net))}</b></span>`;
  }

  function onFilterSheetClick(event) {
    const t = event.target.closest('[data-f-type], [data-f-via], [data-f-stype], [data-f-by], [data-f-cat]');
    if (!t) return;
    if (t.dataset.fType) draftFilters.type = t.dataset.fType;
    const toggle = (set, v) => (set.has(v) ? set.delete(v) : set.add(v));
    if (t.dataset.fVia !== undefined) toggle(draftFilters.via, t.dataset.fVia);
    if (t.dataset.fStype) toggle(draftFilters.stypes, t.dataset.fStype);
    if (t.dataset.fBy !== undefined) toggle(draftFilters.by, t.dataset.fBy);
    if (t.dataset.fCat) toggle(draftFilters.cats, t.dataset.fCat);
    renderFilterSheet();
  }

  function applyFilters(next) {
    filters = next;
    selectedEntryIds.clear();
    renderListDetail();
  }

  /** "− Spent · UPI, Cash · 🍔 Food · “petrol”" */
  function filterSummary(f) {
    const parts = [];
    if (f.type !== 'all') parts.push(f.type === 'spent' ? '− Spent' : '+ Received');
    if (f.via.size) parts.push([...f.via].map(escapeHtml).join(', '));
    if (f.stypes.size) parts.push(SPEND_TYPES.filter((t) => f.stypes.has(t.id)).map((t) => `${t.icon} ${t.label}`).join(', '));
    if (f.by.size) parts.push(`👤 ${[...f.by].map(escapeHtml).join(', ')}`);
    if (f.cats.size) parts.push([...f.cats].map((id) => `${categoryOf(id).icon} ${categoryOf(id).label}`).join(', '));
    if (f.text.trim()) parts.push(`“${escapeHtml(f.text.trim())}”`);
    return parts.join(' · ');
  }

  // ---------- export (📤) ----------

  const EXPORT_KEY = 'myExpenses.export';
  const EXPORT_FORMATS = [
    { id: 'xlsx', icon: '📗', label: 'Excel' },
    { id: 'csv', icon: '📄', label: 'CSV' },
    { id: 'txt', icon: '📝', label: 'Text' },
    { id: 'pdf', icon: '📕', label: 'PDF' },
  ];
  // Amount is always exported; the rest can be switched off. `width` = Excel column width.
  const EXPORT_COLUMNS = [
    { id: 'date', label: 'Date', width: 13 },
    { id: 'time', label: 'Time', width: 10 },
    { id: 'amount', label: 'Amount', width: 14, fixed: true },
    { id: 'purpose', label: 'Purpose', width: 40 },
    { id: 'category', label: 'Category', width: 16 },
    { id: 'via', label: 'Pay via', width: 18 },
    { id: 'stype', label: 'Expense type', width: 13 },
    { id: 'by', label: 'Paid by', width: 14 },
    { id: 'note', label: 'Note', width: 40 },
  ];
  // Range buttons: quick picks on the first line, pickers (with an extra input) on the second.
  const EXPORT_RANGES = [
    ['this', 'This month'],
    ['thisyear', 'This year'],
    ['all', 'All time'],
    ['month', '🗓️ Select month'],
    ['year', '📆 Select year'],
    ['custom', '↔ Date range'],
  ];
  const savedExport = storage((s) => JSON.parse(s.getItem(EXPORT_KEY) || 'null')) || {};
  const exportState = {
    cols: new Set([...(Array.isArray(savedExport.cols) ? savedExport.cols : EXPORT_COLUMNS.map((c) => c.id)), 'amount']),
    rows: 'all', // all (within the range) | selected (only the ticked rows)
    range: 'this', // this | thisyear | all | month | year | custom
    month: '',
    year: '',
    from: '',
    to: '',
    useFilters: true,
  };

  const monthEnd = (ym) => {
    const [y, m] = ym.split('-').map(Number);
    return `${ym}-${pad2(new Date(y, m, 0).getDate())}`;
  };
  const longMonth = (ym) => {
    const [y, m] = ym.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString(LOCALE, { month: 'long', year: 'numeric' });
  };
  /** "13/10/2026" */
  const fullDate = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

  function openExportSheet(tab = 'export') {
    const shown = shownMonth();
    exportState.rows = selectedEntryIds.size ? 'selected' : 'all';
    exportState.range = viewMode === 'all' ? 'all' : shown === currentMonth() ? 'this' : 'month';
    exportState.month = shown;
    exportState.year = shown.slice(0, 4);
    exportState.from = `${shown}-01`;
    exportState.to = monthEnd(shown) < todayISO() ? monthEnd(shown) : todayISO();
    exportState.useFilters = true;
    renderExportSheet();
    if (importResult && importResult.listId !== currentListId) importResult = null;
    showIoTab(tab);
    openSheet($('export-sheet'));
  }

  /** Switch the Import / Export sheet between its two tabs. */
  function showIoTab(tab) {
    for (const t of ['export', 'import']) {
      $(`io-${t}`).hidden = t !== tab;
      $(`io-tab-${t}`).classList.toggle('is-on', t === tab);
      $(`io-tab-${t}`).setAttribute('aria-selected', t === tab);
    }
    if (tab === 'import') renderImportPanel();
  }

  /** [from, to] dates (inclusive) for the chosen range, or null for selected rows / all time. */
  function exportBounds() {
    switch (exportState.range) {
      case 'this':
        return [`${currentMonth()}-01`, monthEnd(currentMonth())];
      case 'thisyear':
        return [`${currentMonth().slice(0, 4)}-01-01`, `${currentMonth().slice(0, 4)}-12-31`];
      case 'month':
        return [`${exportState.month}-01`, monthEnd(exportState.month)];
      case 'year':
        return [`${exportState.year}-01-01`, `${exportState.year}-12-31`];
      case 'custom':
        return [exportState.from || '0000-01-01', exportState.to || '9999-12-31'];
      default:
        return null;
    }
  }

  function exportRangeLabel() {
    if (exportState.rows === 'selected') return 'Selected entries';
    switch (exportState.range) {
      case 'this':
        return longMonth(currentMonth());
      case 'thisyear':
        return currentMonth().slice(0, 4);
      case 'month':
        return longMonth(exportState.month);
      case 'year':
        return exportState.year;
      case 'custom':
        return `${exportState.from ? fullDate(exportState.from) : 'start'} – ${exportState.to ? fullDate(exportState.to) : 'today'}`;
      default:
        return 'All time';
    }
  }

  /** The entries to export, oldest first. */
  function exportEntries() {
    let rows = entries.filter((e) => e.list_id === currentListId);
    if (exportState.rows === 'selected') {
      rows = rows.filter((e) => selectedEntryIds.has(e.id)); // the range doesn't apply to ticked rows
    } else {
      const bounds = exportBounds();
      if (bounds) rows = rows.filter((e) => e.spent_on >= bounds[0] && e.spent_on <= bounds[1]);
    }
    if (exportState.useFilters && activeFilterCount(filters)) rows = rows.filter((e) => matchesFilters(e, filters));
    return [...rows].sort(byDate);
  }

  function renderExportSheet() {
    const pill = (attr, value, label, on, extra = '') =>
      `<button type="button" class="pill ${on ? 'is-on' : ''}" ${attr}="${value}" aria-pressed="${on}" ${extra}>${label}</button>`;

    // 1. Columns
    $('x-cols').innerHTML = EXPORT_COLUMNS.map((c) =>
      pill('data-x-col', c.id, `${exportState.cols.has(c.id) ? '✓ ' : ''}${c.label}`, exportState.cols.has(c.id), c.fixed ? 'disabled title="Always included"' : ''),
    ).join('');

    // 2. Rows: all, or only the ticked rows (only offered when some are ticked)
    const nSel = selectedEntryIds.size;
    if (!nSel && exportState.rows === 'selected') exportState.rows = 'all';
    $('x-rows').innerHTML =
      pill('data-x-rows', 'all', 'All rows', exportState.rows === 'all') +
      pill('data-x-rows', 'selected', `☑ Selected rows only${nSel ? ` (${nSel})` : ''}`, exportState.rows === 'selected', nSel ? '' : 'disabled title="Tick rows in the list first"');

    // 3. Range (ignored for "Selected rows only")
    const rangeOff = exportState.rows === 'selected';
    $('x-range').classList.toggle('is-off', rangeOff);
    $('x-range').innerHTML = EXPORT_RANGES.map(([id, label]) => pill('data-x-range', id, label, !rangeOff && id === exportState.range, rangeOff ? 'disabled' : '')).join('');

    // Extra inputs for "Select month", "Select year" and "Date range".
    let extra = '';
    if (rangeOff) {
      extra = '';
    } else if (exportState.range === 'month') {
      extra = `<input id="x-month" class="input grow" type="month" value="${exportState.month}" aria-label="Month" />`;
    } else if (exportState.range === 'year') {
      const years = new Set([String(new Date().getFullYear()), ...entries.filter((e) => e.list_id === currentListId).map((e) => e.spent_on.slice(0, 4))]);
      extra = `<select id="x-year" class="input grow" aria-label="Year">${[...years]
        .sort()
        .reverse()
        .map((y) => `<option ${y === exportState.year ? 'selected' : ''}>${y}</option>`)
        .join('')}</select>`;
    } else if (exportState.range === 'custom') {
      extra = `
        <label class="field grow"><span class="muted small">From</span><input id="x-from" class="input" type="date" value="${exportState.from}" /></label>
        <label class="field grow"><span class="muted small">To</span><input id="x-to" class="input" type="date" value="${exportState.to}" /></label>`;
    }
    $('x-range-extra').innerHTML = extra;
    $('x-range-extra').hidden = !extra;

    // 4. Export to: one big button per format (tap = download)
    $('x-formats').innerHTML = EXPORT_FORMATS.map(
      (f) => `
        <button type="button" class="x-format" data-x-format="${f.id}" title="Export to ${f.label}">
          <span class="x-format-icon" aria-hidden="true">${f.icon}</span>
          <span class="x-format-name">${f.label}</span>
        </button>`,
    ).join('');

    $('x-filters-wrap').hidden = !activeFilterCount(filters);
    $('x-filters').checked = exportState.useFilters;
    updateExportSummary();
  }

  function updateExportSummary() {
    const rows = exportEntries();
    let out = 0;
    let inn = 0;
    for (const e of rows) {
      if (e.direction === 'credit') inn += e.amount;
      else out += e.amount;
    }
    const n = rows.length;
    $('x-summary').innerHTML = `
      <span><b>${n}</b> ${n === 1 ? 'entry' : 'entries'}</span>
      <span>Spent <b class="amount-out">− ${money.format(out)}</b></span>
      <span>Received <b class="amount-in">+ ${money.format(inn)}</b></span>`;
    for (const b of document.querySelectorAll('#x-formats .x-format')) b.disabled = n === 0;
  }

  function onExportSheetClick(event) {
    const t = event.target.closest('[data-x-format], [data-x-rows], [data-x-range], [data-x-col]');
    if (!t || t.disabled) return;
    if (t.dataset.xFormat) return runExport(t.dataset.xFormat);
    if (t.dataset.xRows) exportState.rows = t.dataset.xRows;
    if (t.dataset.xRange) exportState.range = t.dataset.xRange;
    if (t.dataset.xCol) {
      if (exportState.cols.has(t.dataset.xCol)) exportState.cols.delete(t.dataset.xCol);
      else exportState.cols.add(t.dataset.xCol);
    }
    renderExportSheet();
  }

  function onExportSheetInput(event) {
    const id = event.target.id;
    if (id === 'x-month' && event.target.value) exportState.month = event.target.value;
    if (id === 'x-year') exportState.year = event.target.value;
    if (id === 'x-from') exportState.from = event.target.value;
    if (id === 'x-to') exportState.to = event.target.value;
    if (id === 'x-filters') exportState.useFilters = event.target.checked;
    updateExportSummary();
  }

  /** Text value of one column for one entry (amount is signed text: "− ₹540.00"). */
  function exportText(col, e) {
    switch (col) {
      case 'date':
        return fullDate(e.spent_on);
      case 'time':
        return formatTime(entryTime(e));
      case 'amount':
        return signed(e);
      case 'purpose':
        return entryPurpose(e);
      case 'category':
        return categoryOf(e.category).label;
      case 'via':
        return e.pay_via || '';
      case 'stype':
        return spendTypeOf(e)?.label || '';
      case 'by': {
        const v = entryPaidBy(e);
        return v === '—' ? '' : v;
      }
      case 'note':
        return entryNote(e);
      default:
        return '';
    }
  }

  const signedNumber = (e) => (e.direction === 'credit' ? 1 : -1) * e.amount;
  const excelSerial = (iso) => {
    const [y, m, d] = iso.split('-').map(Number);
    return (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86_400_000;
  };
  const safeFileName = (s) => s.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim();

  function runExport(format) {
    const rows = exportEntries();
    if (!rows.length) return;
    const list = findList(currentListId);
    const cols = EXPORT_COLUMNS.filter((c) => exportState.cols.has(c.id));
    const rangeLabel = exportRangeLabel();
    const baseName = safeFileName(`${list.name} - ${rangeLabel}`);
    let out = 0;
    let inn = 0;
    for (const e of rows) {
      if (e.direction === 'credit') inn += e.amount;
      else out += e.amount;
    }
    storage((s) => s.setItem(EXPORT_KEY, JSON.stringify({ cols: [...exportState.cols] })));

    if (format === 'xlsx' || format === 'csv') {
      const header = cols.map((c) => ({ v: c.id === 'amount' ? `Amount (${cfg.CURRENCY || 'INR'})` : c.label, s: 1 }));
      const body = rows.map((e) =>
        cols.map((c) => {
          if (c.id === 'amount') return { v: signedNumber(e).toFixed(2), t: 'n', s: 3 }; // spent = negative
          if (c.id === 'date' && format === 'xlsx') return { v: excelSerial(e.spent_on), t: 'n', s: 2 };
          return { v: exportText(c.id, e) };
        }),
      );
      const blob =
        format === 'xlsx'
          ? Exporter.xlsx([header, ...body], { widths: cols.map((c) => c.width), sheetName: list.name })
          : Exporter.csv([header, ...body]);
      Exporter.download(blob, `${baseName}.${format}`);
    } else if (format === 'txt') {
      const table = [cols.map((c) => c.label), ...rows.map((e) => cols.map((c) => exportText(c.id, e).replace(/\s+/g, ' ')))];
      const widths = cols.map((_, i) => Math.max(...table.map((r) => r[i].length)));
      const line = (r) => r.map((v, i) => (cols[i].id === 'amount' ? v.padStart(widths[i]) : v.padEnd(widths[i]))).join('   ').trimEnd();
      const text = [
        `${list.name} — ${rangeLabel}`,
        `${rows.length} ${rows.length === 1 ? 'entry' : 'entries'} · Spent − ${money.format(out)} · Received + ${money.format(inn)} · Net ${inn - out < 0 ? '−' : '+'} ${money.format(Math.abs(inn - out))}`,
        `Exported ${fullDate(todayISO())} from Expense Manager`,
        '',
        line(table[0]),
        widths.map((w) => '-'.repeat(w)).join('   '),
        ...table.slice(1).map(line),
      ].join('\r\n');
      Exporter.download(new Blob(['﻿', text], { type: 'text/plain;charset=utf-8' }), `${baseName}.txt`);
    } else {
      printPdf(list, cols, rows, rangeLabel, out, inn, baseName);
    }
    closeSheet($('export-sheet'));
    toast(format === 'pdf' ? '🖨 Choose "Save as PDF" in the print window' : `⬇ Exported ${rows.length} ${rows.length === 1 ? 'entry' : 'entries'}`);
  }

  /** PDF: print a formatted report; the browser's print window offers "Save as PDF". */
  function printPdf(list, cols, rows, rangeLabel, out, inn, baseName) {
    const net = inn - out;
    const th = cols.map((c) => `<th class="${c.id}">${c.label}</th>`).join('');
    const tr = rows
      .map((e) => `<tr>${cols.map((c) => `<td class="${c.id} ${c.id === 'amount' ? (e.direction === 'credit' ? 'in' : 'out') : ''}">${escapeHtml(exportText(c.id, e))}</td>`).join('')}</tr>`)
      .join('');
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(baseName)}</title><style>
      @page { size: A4; margin: 14mm; }
      body { font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; color: #1f2937; font-size: 11px; }
      h1 { font-size: 18px; margin: 0 0 2px; color: #4f46e5; }
      .meta { color: #6b7280; margin: 0 0 10px; }
      .totals { display: flex; gap: 18px; margin: 0 0 12px; padding: 8px 10px; background: #f3f4f8; border-radius: 6px; }
      table { width: 100%; border-collapse: collapse; }
      th { text-align: left; background: #ede9fe; color: #3730a3; padding: 6px; font-size: 10px; text-transform: uppercase; letter-spacing: .04em; }
      td { padding: 5px 6px; border-bottom: 1px solid #e5e7eb; vertical-align: top; }
      tr:nth-child(even) td { background: #fafafa; }
      .amount { text-align: right; white-space: nowrap; font-weight: 700; }
      .date, .time { white-space: nowrap; }
      .out { color: #b91c1c; } .in { color: #15803d; }
      th, td { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    </style></head><body>
      <h1>💰 ${escapeHtml(list.name)}</h1>
      <p class="meta">${escapeHtml(rangeLabel)} · ${rows.length} ${rows.length === 1 ? 'entry' : 'entries'} · exported ${fullDate(todayISO())}</p>
      <div class="totals">
        <span>Spent <b class="out">− ${money.format(out)}</b></span>
        <span>Received <b class="in">+ ${money.format(inn)}</b></span>
        <span>Net <b class="${net < 0 ? 'out' : 'in'}">${net < 0 ? '−' : '+'} ${money.format(Math.abs(net))}</b></span>
      </div>
      <table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>
    </body></html>`;
    const frame = Object.assign(document.createElement('iframe'), { title: 'Print preview' });
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
    frame.srcdoc = html;
    frame.onload = () => {
      // The page title becomes the suggested PDF file name.
      const previous = document.title;
      document.title = baseName;
      frame.contentWindow.focus();
      frame.contentWindow.print();
      document.title = previous;
      setTimeout(() => frame.remove(), 60_000);
    };
    document.body.appendChild(frame);
  }

  // ---------- import (📥) ----------

  // Header names recognised in imported files (compared after lower-casing and dropping
  // punctuation and anything in brackets, e.g. "Amount (INR)" → "amount").
  const IMPORT_HEADERS = {
    date: ['date', 'txn date', 'transaction date', 'value date', 'posting date', 'day'],
    time: ['time'],
    amount: ['amount', 'amt', 'value', 'total'],
    debit: ['debit', 'withdrawal', 'withdrawals', 'withdrawal amt', 'debit amount', 'spent', 'expense', 'dr'],
    credit: ['credit', 'deposit', 'deposits', 'deposit amt', 'credit amount', 'received', 'income', 'cr'],
    type: ['type', 'direction', 'dr cr', 'cr dr', 'txn type', 'transaction type'],
    purpose: ['purpose', 'description', 'narration', 'details', 'particulars', 'item', 'title', 'transaction details'],
    category: ['category'],
    via: ['pay via', 'paid via', 'received via', 'payment', 'payment mode', 'payment method', 'mode', 'method'],
    by: ['paid by', 'received by', 'by', 'person', 'payer'],
    note: ['note', 'notes', 'remarks', 'remark', 'comment', 'comments', 'memo'],
  };
  const IMPORT_FIELD_LABELS = {
    date: 'Date', time: 'Time', amount: 'Amount', debit: 'Debit', credit: 'Credit', type: 'Type',
    purpose: 'Purpose', category: 'Category', via: 'Pay via', by: 'Paid by', note: 'Note',
  };
  // Words in a purpose that mean money came in (only for pasted text without signs or a header).
  const MONEY_IN_WORDS = /\b(received|receive|salary|refund(ed)?|cashback|credited|interest|bonus|reimburse(d|ment)?|dividend|income)\b/i;
  const INCOME_WORDS = /\b(salary|interest|bonus|dividend|income)\b/i;
  const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const normHeader = (h) => String(h).toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

  let importResult = null; // { listId, fileName, rows, skipped, map }

  function mapImportHeaders(row) {
    const map = {};
    row.forEach((h, i) => {
      const name = normHeader(h);
      if (!name) return;
      for (const [field, names] of Object.entries(IMPORT_HEADERS)) {
        if (map[field] === undefined && (names.includes(name) || (field === 'amount' && name.startsWith('amount')))) {
          map[field] = i;
          break;
        }
      }
    });
    return map;
  }

  /** Dates as Excel serials, "13/10/2026", "13-10-26", "2026-10-13", "13 Oct 2026", "Oct 13, 2026", "Mon, 1/02/26" (day first). */
  function parseImportDate(v) {
    const ymd = (y, m, d) => (m >= 1 && m <= 12 && d >= 1 && d <= 31 && y > 1900 ? `${y}-${pad2(m)}-${pad2(d)}` : null);
    if (typeof v === 'number') {
      if (v < 60 || v > 80000) return null;
      const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * 86_400_000);
      return ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    }
    const s = String(v).trim().replace(/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s+/i, '');
    const year = (y) => (y.length === 2 ? 2000 + Number(y) : Number(y));
    const monthNo = (name) => MONTH_NAMES.indexOf(name.slice(0, 3).toLowerCase()) + 1;
    let m;
    if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/))) return ymd(+m[1], +m[2], +m[3]);
    if ((m = s.match(/^(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{2,4})\b/))) return ymd(year(m[3]), +m[2], +m[1]);
    if ((m = s.match(/^(\d{1,2})[-/ ]([a-z]{3,9})[-/ ,]*(\d{2,4})\b/i))) return ymd(year(m[3]), monthNo(m[2]), +m[1]);
    if ((m = s.match(/^([a-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})/i))) return ymd(+m[3], monthNo(m[1]), +m[2]);
    return null;
  }

  /** "10:44 AM", "10:44AM", "22:05", "10:44:00", or an Excel time fraction → 'HH:MM' ('' if none). */
  function parseImportTime(v) {
    if (typeof v === 'number') {
      const frac = v % 1;
      if (!frac) return '';
      const mins = Math.round(frac * 1440) % 1440;
      return `${pad2(Math.floor(mins / 60))}:${pad2(mins % 60)}`;
    }
    const m = String(v).match(/\b(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap])?\.?\s*m?\b/i);
    if (!m) return '';
    let h = Number(m[1]);
    const ampm = m[3]?.toLowerCase();
    if (ampm === 'p' && h < 12) h += 12;
    if (ampm === 'a' && h === 12) h = 0;
    return h < 24 && Number(m[2]) < 60 ? `${pad2(h)}:${m[2]}` : '';
  }

  /** "− ₹1,200.00", "-1200", "1,200 Dr", "(1,200)", "+25,000", 25000 → { value, credit } (credit = marked as money in). */
  function parseImportAmount(v) {
    if (typeof v === 'number') return Number.isFinite(v) && v !== 0 ? { value: v, credit: false } : null;
    let s = String(v).trim();
    if (!s) return null;
    let sign = 1;
    let credit = false;
    if (/^\(.*\)$/.test(s)) {
      sign = -1;
      s = s.slice(1, -1);
    }
    if (/\bdr\.?$/i.test(s)) sign = -1;
    if (/\bcr\.?$/i.test(s)) credit = true;
    s = s.replace(/\b(dr|cr)\.?$/i, '').replace(/rs\.?|inr|[₹$€£,\s]/gi, '').replace(/[−–]/g, '-');
    if (s.startsWith('+')) credit = true;
    const n = Number(s);
    if (!Number.isFinite(n) || n === 0) return null;
    return { value: sign * n, credit };
  }

  /** No header row (e.g. pasted lines): guess the Date, Amount, Time and Purpose columns from the data. */
  function guessHeaderlessMap(table) {
    const sample = table.slice(0, 20);
    if (!sample.length) return null;
    const width = Math.max(...sample.map((r) => r.length));
    const share = (i, test) => sample.filter((r) => test(r[i] ?? '')).length / sample.length;
    const isTime = (v) => typeof v === 'string' && /\d:\d\d/.test(v) && !parseImportDate(v);
    const isAmount = (v) => !isTime(v) && !parseImportDate(v) && Boolean(parseImportAmount(v));
    const cols = [...Array(width).keys()];
    const date = cols.find((i) => share(i, (v) => parseImportDate(v)) >= 0.6);
    const amount = cols.find((i) => i !== date && share(i, isAmount) >= 0.6);
    if (date === undefined || amount === undefined) return null;
    const time = cols.find((i) => i !== date && i !== amount && share(i, isTime) >= 0.6);
    // The remaining text columns, left to right: purpose, then pay via, then note.
    const hasText = (i) => sample.some((r) => String(r[i] ?? '').trim() && !isAmount(r[i]));
    const [purpose, via, note] = cols.filter((i) => ![date, amount, time].includes(i) && hasText(i));
    const map = { date, amount };
    if (time !== undefined) map.time = time;
    if (purpose !== undefined) map.purpose = purpose;
    if (via !== undefined) map.via = via;
    if (note !== undefined) map.note = note;
    return map;
  }

  /** Header row → entries ready to save, plus how many rows had no usable date/amount. */
  function convertImportTable(table) {
    let headerIdx = -1;
    let map = null;
    for (let i = 0; i < Math.min(15, table.length); i++) {
      const m = mapImportHeaders(table[i]);
      if (m.date !== undefined && (m.amount !== undefined || m.debit !== undefined || m.credit !== undefined)) {
        headerIdx = i;
        map = m;
        break;
      }
    }
    let guessed = false;
    if (headerIdx < 0) {
      map = guessHeaderlessMap(table); // e.g. pasted rows without a header
      guessed = Boolean(map);
      if (!map) {
        throw new Error("Couldn't find the Date and Amount columns. Add a first row with column names like Date, Amount, Purpose.");
      }
    }
    const data = table.slice(headerIdx + 1);
    const cell = (row, field) => (map[field] === undefined ? '' : row[map[field]] ?? '');
    // Exports from this app (and most banks) mark spent amounts as negative, so in a file with a
    // header and some negative amounts, positive ones are money received. Without a header (e.g.
    // pasted lines) a plain number is spent unless it's marked "+" or "Cr".
    const fileHasNegatives =
      !guessed && map.amount !== undefined && data.some((r) => (parseImportAmount(cell(r, 'amount'))?.value ?? 0) < 0);
    const allCategories = [...CATEGORIES, ...RETIRED_CATEGORIES];

    const rows = [];
    let skipped = 0;
    for (const row of data) {
      const spent_on = parseImportDate(cell(row, 'date'));
      let amount = 0;
      let direction = 'debit';
      let decided = false; // direction came from a sign, Dr/Cr, a Type column or Debit/Credit columns
      if (map.amount !== undefined) {
        const a = parseImportAmount(cell(row, 'amount'));
        if (a) {
          amount = Math.abs(a.value);
          direction = a.value < 0 ? 'debit' : a.credit || fileHasNegatives ? 'credit' : 'debit';
          decided = a.value < 0 || a.credit || fileHasNegatives;
        }
      }
      if (!amount) {
        const cr = parseImportAmount(cell(row, 'credit'));
        const dr = parseImportAmount(cell(row, 'debit'));
        if (cr) [amount, direction] = [Math.abs(cr.value), 'credit'];
        else if (dr) [amount, direction] = [Math.abs(dr.value), 'debit'];
        decided = Boolean(cr || dr);
      }
      const type = normHeader(cell(row, 'type'));
      if (/^(cr|credit|received|receive|income|deposit|in)\b/.test(type)) [direction, decided] = ['credit', true];
      else if (/^(dr|debit|spent|spend|expense|withdrawal|out)\b/.test(type)) [direction, decided] = ['debit', true];
      // Pasted text without a header or signs: a purpose like "Salary received" means money in.
      const purposeText = String(cell(row, 'purpose'));
      if (guessed && !decided && MONEY_IN_WORDS.test(purposeText)) direction = 'credit';
      if (!spent_on || !amount) {
        skipped++;
        continue;
      }

      const catName = normHeader(cell(row, 'category'));
      const cat = catName && allCategories.find((c) => c.id === catName || normHeader(c.label) === catName || normHeader(c.label).split(' ')[0] === catName);
      const category = cat
        ? cat.id
        : direction !== 'credit'
          ? DEFAULT_SPEND_CATEGORY
          : INCOME_WORDS.test(purposeText)
            ? 'income'
            : DEFAULT_RECEIVE_CATEGORY;
      const text = (field) => String(cell(row, field)).replace(/\s+/g, ' ').trim();
      rows.push({
        spent_on,
        spent_time: parseImportTime(cell(row, 'time')) || parseImportTime(cell(row, 'date')) || '12:00',
        direction,
        amount: Math.round(amount * 100) / 100,
        category,
        purpose: text('purpose').slice(0, 200) || categoryOf(category).label,
        note: String(cell(row, 'note')).trim().slice(0, 500),
        pay_via: text('via').slice(0, 40),
        paid_by: text('by').slice(0, 60) || firstName(),
      });
    }
    return { rows, skipped, map, guessed };
  }

  const importKey = (e) => `${e.spent_on}|${e.direction}|${Number(e.amount).toFixed(2)}|${String(e.purpose || entryPurpose(e)).toLowerCase()}`;

  /** Rows that will be added: skips ones already in the list (same date, type, amount and purpose) if asked. */
  function importRowsToAdd() {
    if (!importResult) return [];
    return importResult.rows.filter((r) => !(r.duplicate && $('im-skip-dupes').checked));
  }

  /** Reads a table (from a file or pasted text) and shows the preview. `source` names it in messages. */
  async function loadImport(source, readTable, fromFile) {
    setError('im-error', '');
    importResult = null;
    try {
      const result = convertImportTable(await readTable());
      const existing = new Set(entries.filter((e) => e.list_id === currentListId).map(importKey));
      for (const r of result.rows) r.duplicate = existing.has(importKey(r));
      if (!result.rows.length) throw new Error(`No entries found in ${source}. Each row needs a date and an amount.`);
      importResult = { listId: currentListId, fileName: source, fromFile, ...result };
      $('im-skip-dupes').checked = true;
    } catch (e) {
      setError('im-error', e?.message || String(e));
    }
    renderImportPanel();
    if (importResult) $('im-result').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  async function onImportFile() {
    const file = $('im-file').files[0];
    if (!file) return;
    $('im-drop-title').textContent = `Reading ${file.name}…`;
    await loadImport(file.name, () => Importer.readTable(file), true);
    $('im-file').value = ''; // so choosing the same file again re-reads it
  }

  function onImportPaste() {
    const text = $('im-text').value;
    if (!text.trim()) return setError('im-error', 'Paste some rows into the box first.');
    loadImport('the pasted text', async () => Importer.readText(text), false);
  }

  function renderImportPanel() {
    const list = findList(currentListId);
    $('im-list').textContent = list ? list.name : '';
    const allowed = Boolean(list && canAddEntries(list));
    $('im-readonly').hidden = allowed;
    $('im-drop').classList.toggle('is-disabled', !allowed);
    $('im-file').disabled = !allowed;
    $('im-text').disabled = !allowed;
    $('im-text-go').disabled = !allowed;
    $('im-drop-title').textContent = importResult?.fromFile ? `📄 ${importResult.fileName}` : 'Choose a file';
    $('im-result').hidden = !importResult;
    if (!importResult) return;

    const { rows, skipped, map, fileName, guessed } = importResult;
    $('im-found').innerHTML =
      `Found <b>${rows.length}</b> ${rows.length === 1 ? 'entry' : 'entries'} in <b>${escapeHtml(fileName)}</b>` +
      (skipped ? ` <span class="muted">· ${skipped} ${skipped === 1 ? 'row' : 'rows'} skipped (no date or amount)</span>` : '');
    $('im-cols').textContent = `${guessed ? 'No header row, so the columns were guessed: ' : 'Columns found: '}${Object.keys(IMPORT_FIELD_LABELS).filter((f) => map[f] !== undefined).map((f) => IMPORT_FIELD_LABELS[f]).join(', ')}`;

    const preview = rows.slice(0, 5);
    $('im-preview').innerHTML = `
      <table>
        ${preview
          .map(
            (r) => `<tr class="${r.duplicate ? 'is-dup' : ''}">
              <td>${formatDay(r.spent_on)}</td>
              <td class="${r.direction === 'credit' ? 'amount-in' : 'amount-out'}">${r.direction === 'credit' ? '+' : '−'} ${money.format(r.amount)}</td>
              <td>${categoryOf(r.category).icon} ${escapeHtml(r.purpose)}${r.duplicate ? ' <span class="badge">already added</span>' : ''}</td>
            </tr>`,
          )
          .join('')}
      </table>
      ${rows.length > preview.length ? `<p class="muted small">…and ${rows.length - preview.length} more</p>` : ''}`;

    const dupes = rows.filter((r) => r.duplicate).length;
    $('im-dupes-wrap').hidden = !dupes;
    $('im-dupes-label').textContent = `Skip ${dupes} ${dupes === 1 ? 'entry' : 'entries'} already in this list`;
    updateImportSummary();
  }

  function updateImportSummary() {
    const rows = importRowsToAdd();
    let out = 0;
    let inn = 0;
    for (const r of rows) {
      if (r.direction === 'credit') inn += r.amount;
      else out += r.amount;
    }
    $('im-summary').innerHTML = `
      <span><b>${rows.length}</b> to import</span>
      <span>Spent <b class="amount-out">− ${money.format(out)}</b></span>
      <span>Received <b class="amount-in">+ ${money.format(inn)}</b></span>`;
    $('im-go').disabled = !rows.length;
    $('im-go').textContent = rows.length ? `📥 Import ${rows.length} ${rows.length === 1 ? 'entry' : 'entries'}` : 'Nothing new to import';
  }

  async function runImport() {
    const rows = importRowsToAdd();
    const list = findList(currentListId);
    if (!rows.length || !list || !canAddEntries(list)) return;
    const uid = currentUserId();
    const start = Date.now();
    await DB.putMany(
      'expenses',
      rows.map(({ duplicate, ...r }, i) => {
        const at = new Date(start + i).toISOString(); // distinct, ordered created_at
        return { id: newId(), user_id: uid, list_id: list.id, author_name: myName(), ...r, created_at: at, updated_at: at, deleted: false, favorite: false, synced: 0 };
      }),
    );
    importResult = null;
    $('im-text').value = '';
    closeSheet($('export-sheet'));
    // Show the imported entries: jump to the newest imported month (month and calendar views).
    const newest = rows.reduce((max, r) => (r.spent_on > max ? r.spent_on : max), '');
    if (viewMode !== 'all') selectedMonthByList.set(list.id, newest.slice(0, 7));
    await afterWrite();
    toast(`📥 Imported ${rows.length} ${rows.length === 1 ? 'entry' : 'entries'}`);
  }

  /** A small CSV showing the columns import understands. */
  function downloadImportSample() {
    const header = ['Date', 'Time', 'Amount', 'Purpose', 'Category', 'Pay via', 'Paid by', 'Note'].map((v) => ({ v }));
    const sample = [
      [fullDate(todayISO()), '09:30 AM', '-120.00', 'Breakfast', 'Food', 'UPI', firstName(), ''],
      [fullDate(todayISO()), '06:15 PM', '-540.00', 'Petrol', 'Fuel', 'Cash', firstName(), 'Full tank'],
      [fullDate(todayISO()), '10:00 AM', '25000.00', 'Salary', 'Income', 'Net banking', firstName(), 'Negative = spent, positive = received'],
    ].map((r) => r.map((v) => ({ v })));
    Exporter.download(Exporter.csv([header, ...sample]), 'Expense Manager - import sample.csv');
  }

  // ---------- view mode (📊) ----------

  const VIEW_KEY = 'myExpenses.viewMode';
  // Add new view modes here; renderListDetail decides which entries each one shows.
  const VIEW_MODES = [
    { id: 'month', icon: '📅', label: 'Month view', hint: 'One month at a time. Use ◀ ▶ or the month button to change month.' },
    { id: 'all', icon: '📜', label: 'Long list', hint: 'All months in one list, newest at the bottom like a chat. Scroll up for older months.' },
    { id: 'calendar', icon: '🗓️', label: 'Calendar', hint: 'Each day of the month with its total. Tap a day to see its entries.' },
    { id: 'year', icon: '📆', label: 'Year view', hint: 'All 12 months of the year with each month’s total. Tap a month to see its entries.' },
    { id: 'chart', icon: '🍩', label: 'Charts', hint: 'The month or year as a donut, pie, bar or column chart: by category, payment method, or over time.' },
    { id: 'budget', icon: '🎯', label: 'Budget plan', hint: 'The month’s income split 50 · 30 · 20 into Needs, Wants and Savings, from each entry’s expense type.' },
  ];
  let viewMode = storage((s) => s.getItem(VIEW_KEY)) || 'month';
  if (!VIEW_MODES.some((m) => m.id === viewMode)) viewMode = 'month';

  function setViewMode(mode) {
    if (mode === viewMode) return;
    viewMode = mode;
    storage((s) => s.setItem(VIEW_KEY, mode));
    selectedEntryIds.clear();
    renderListDetail();
  }

  function openViewSheet() {
    $('vm-options').innerHTML = VIEW_MODES.map(
      (m) => `
        <button type="button" role="radio" class="vm-option ${m.id === viewMode ? 'is-on' : ''}" data-view-mode="${m.id}" aria-checked="${m.id === viewMode}">
          <span class="vm-icon" aria-hidden="true">${m.icon}</span>
          <span class="vm-text"><strong>${m.label}</strong><span class="muted small">${m.hint}</span></span>
          <span class="vm-check" aria-hidden="true">${m.id === viewMode ? '✓' : ''}</span>
        </button>`,
    ).join('');
    openSheet($('view-sheet'));
  }

  // ---------- month calendar sheet ----------

  let calendarYear = new Date().getFullYear();
  let yearPicking = false; // true while the grid shows years instead of months
  const YEAR_PAGE = 12;
  const yearPageStart = () => calendarYear - ((((calendarYear - 1) % YEAR_PAGE) + YEAR_PAGE) % YEAR_PAGE); // e.g. 2017–2028

  function openMonthSheet() {
    calendarYear = Number(shownMonth().slice(0, 4));
    yearPicking = false;
    renderMonthSheet();
    openSheet($('month-sheet'));
  }

  function renderMonthSheet() {
    $('month-sheet').classList.toggle('is-years', yearPicking);
    $('ms-prev-year').setAttribute('aria-label', yearPicking ? 'Previous years' : 'Previous year');
    $('ms-next-year').setAttribute('aria-label', yearPicking ? 'Next years' : 'Next year');
    if (yearPicking) return renderYearGrid();
    $('ms-year').innerHTML = `${calendarYear} <span class="ms-caret" aria-hidden="true">▾</span>`;
    $('ms-year').setAttribute('aria-label', `${calendarYear}, choose year`);
    const selected = viewMode === 'month' ? shownMonth() : null; // nothing highlighted in long-list view
    const today = currentMonth();
    $('ms-grid').innerHTML = Array.from({ length: 12 }, (_, i) => {
      const key = `${calendarYear}-${pad2(i + 1)}`;
      const count = monthCounts.get(key) || 0;
      const name = new Date(calendarYear, i, 1).toLocaleDateString('en-US', { month: 'short' });
      const cls = ['ms-month', key === selected ? 'is-selected' : '', key === today ? 'is-today' : ''].join(' ');
      return `
        <button type="button" class="${cls}" data-month="${key}" aria-pressed="${key === selected}">
          <span class="ms-name">${name}</span>
          <span class="ms-count">${count ? `${count} ${count === 1 ? 'entry' : 'entries'}` : '—'}</span>
        </button>`;
    }).join('');
    $('ms-today').disabled = selected === today;
  }

  function renderYearGrid() {
    const start = yearPageStart();
    const thisYear = new Date().getFullYear();
    $('ms-year').innerHTML = `${start} – ${start + YEAR_PAGE - 1} <span class="ms-caret" aria-hidden="true">▴</span>`;
    $('ms-year').setAttribute('aria-label', 'Back to months');
    $('ms-grid').innerHTML = Array.from({ length: YEAR_PAGE }, (_, i) => {
      const year = start + i;
      let count = 0;
      for (const [key, n] of monthCounts) if (key.startsWith(`${year}-`)) count += n;
      const cls = ['ms-month', year === calendarYear ? 'is-selected' : '', year === thisYear ? 'is-today' : ''].join(' ');
      return `
        <button type="button" class="${cls}" data-year="${year}" aria-pressed="${year === calendarYear}">
          <span class="ms-name">${year}</span>
          <span class="ms-count">${count ? `${count} ${count === 1 ? 'entry' : 'entries'}` : '—'}</span>
        </button>`;
    }).join('');
  }

  // ---------- sorting (tap an icon to sort by it; tap it again to flip ▲ / ▼) ----------

  const SORT_KEY = 'myExpenses.entrySort';
  const CURRENCY_SYMBOL = moneyWhole.formatToParts(0).find((p) => p.type === 'currency')?.value || '₹';
  const SORT_FIELDS = [
    { id: 'date', icon: '📅', name: 'date' },
    { id: 'amount', icon: CURRENCY_SYMBOL, name: 'amount', text: true },
    { id: 'category', icon: '🏷️', name: 'category' },
    { id: 'by', icon: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>', name: 'paid by', svg: true },
    { id: 'via', icon: '💳', name: 'pay via' },
  ];
  const SORT_LABELS = {
    'date-asc': 'Date: oldest first',
    'date-desc': 'Date: newest first',
    'amount-asc': 'Amount: low to high',
    'amount-desc': 'Amount: high to low',
    'category-asc': 'Category: A → Z',
    'category-desc': 'Category: Z → A',
    'via-asc': 'Pay via: A → Z',
    'via-desc': 'Pay via: Z → A',
    'by-asc': 'Paid by: A → Z',
    'by-desc': 'Paid by: Z → A',
  };
  const DEFAULT_SORT = 'date-asc';
  let sortMode = storage((s) => s.getItem(SORT_KEY)) || DEFAULT_SORT;
  if (!SORT_LABELS[sortMode]) sortMode = DEFAULT_SORT;

  // Day totals only: each day collapses to one line with its total (tap the icon again to expand).
  const DAYS_ONLY_KEY = 'myExpenses.daysOnly';
  let daysOnly = storage((s) => s.getItem(DAYS_ONLY_KEY)) === '1';

  function toggleDaysOnly() {
    daysOnly = !daysOnly;
    storage((s) => (daysOnly ? s.setItem(DAYS_ONLY_KEY, '1') : s.removeItem(DAYS_ONLY_KEY)));
    renderListDetail();
    toast(daysOnly ? '📊 Day totals only' : '📋 All entries');
  }

  function toggleSort(field) {
    const [current, dir] = sortMode.split('-');
    sortMode = current === field ? `${field}-${dir === 'asc' ? 'desc' : 'asc'}` : `${field}-asc`;
    storage((s) => s.setItem(SORT_KEY, sortMode));
    renderListDetail();
    toast(`↕ ${SORT_LABELS[sortMode]}`);
  }

  /** ↺: back to the normal list — default order, and out of "day totals only". */
  function resetSort() {
    sortMode = DEFAULT_SORT;
    daysOnly = false;
    storage((s) => {
      s.removeItem(SORT_KEY);
      s.removeItem(DAYS_ONLY_KEY);
    });
    renderListDetail();
    toast(`⟲ Back to ${SORT_LABELS[sortMode].toLowerCase()}`);
  }

  const byDate = (a, b) => a.spent_on.localeCompare(b.spent_on) || entryTime(a).localeCompare(entryTime(b)) || a.created_at.localeCompare(b.created_at);
  const byText = (get) => (a, b) => {
    const x = get(a);
    const y = get(b);
    if (!x !== !y) return x ? -1 : 1; // blanks last
    return x.localeCompare(y, undefined, { sensitivity: 'base' });
  };

  function sortEntries(rows) {
    const [field, dir] = sortMode.split('-');
    const compare = {
      date: byDate,
      amount: (a, b) => a.amount - b.amount,
      category: byText((e) => categoryOf(e.category).label),
      via: byText((e) => e.pay_via || ''),
      by: byText((e) => { const v = entryPaidBy(e); return v === '—' ? '' : v; }),
    }[field];
    const sign = dir === 'desc' ? -1 : 1;
    // Ties fall back to date (oldest first) so the order is stable.
    return [...rows].sort((a, b) => sign * compare(a, b) || byDate(a, b));
  }

  const isNormalList = () => sortMode === DEFAULT_SORT && !daysOnly;

  /** The row of sort icons above the entries; the active one is highlighted with ▲ / ▼ (all off in day totals). */
  function sortIconsHtml() {
    const [field, dir] = sortMode.split('-');
    return SORT_FIELDS.map((f) => {
      const on = f.id === field && !daysOnly;
      const title = daysOnly ? 'Sorting is off while showing day totals' : on ? SORT_LABELS[sortMode] : `Sort by ${f.name}`;
      return `<button type="button" class="sort-icon${on ? ' is-on' : ''}" data-sort="${f.id}" title="${title}" aria-label="${title}" aria-pressed="${on}"${daysOnly ? ' disabled' : ''}>
        <span class="sort-glyph${f.text ? ' is-text' : ''}${f.svg ? ' is-svg' : ''}" aria-hidden="true">${f.icon}</span>${on ? `<span class="sort-ind" aria-hidden="true">${dir === 'asc' ? '▲' : '▼'}</span>` : ''}
      </button>`;
    }).join('') + `
      <span class="sort-divider" aria-hidden="true"></span>
      <button type="button" class="sort-icon${daysOnly ? ' is-on' : ''}" data-days-only title="${daysOnly ? 'Show all entries' : 'Show day totals only'}" aria-label="${daysOnly ? 'Show all entries' : 'Show day totals only'}" aria-pressed="${daysOnly}">
        <svg class="sort-svg" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true">${daysOnly
          ? '<path d="M4 6h16M4 10h16M4 14h16M4 18h16"/>'
          : '<path d="M4 7h16M4 17h16"/><path d="M9 11.5l3 2.5 3-2.5" stroke-linejoin="round"/>'}</svg>
      </button>`;
  }

  // ---------- selecting rows → floating total ----------

  const selectedEntryIds = new Set();

  function renderSelection() {
    const chosen = entries.filter((e) => selectedEntryIds.has(e.id));
    $('selection-bar').hidden = chosen.length === 0;
    $('entries').classList.toggle('has-selection', chosen.length > 0);
    const all = document.getElementById('select-all');
    if (all) {
      const ids = visibleEntryIds();
      const checked = ids.filter((id) => selectedEntryIds.has(id)).length;
      all.checked = ids.length > 0 && checked === ids.length;
      all.indeterminate = checked > 0 && checked < ids.length;
    }
    // Day headers: ticked when all of that day's entries are, half when some are.
    for (const dayBox of document.querySelectorAll('#entries .day-sep input[data-day-check]')) {
      const ids = dayBox.dataset.ids.split(',');
      const checked = ids.filter((id) => selectedEntryIds.has(id)).length;
      dayBox.checked = checked === ids.length;
      dayBox.indeterminate = checked > 0 && checked < ids.length;
    }
    if (!chosen.length) return;
    $('sel-edit').hidden = !chosen.some(canDeleteEntry);
    $('sel-delete').hidden = !chosen.some(canDeleteEntry);
    const { out, inn, outCash, inCash } = moneyTotals(chosen);
    const net = inn - out;
    $('sel-count').textContent = `(${chosen.length})`;
    $('sel-count').title = `${chosen.length} selected`;
    $('sel-total').textContent = `${net < 0 ? '−' : net > 0 ? '+' : ''} ${money.format(Math.abs(net))}`;
    $('sel-total').className = net < 0 ? 'amount-out' : 'amount-in';
    // Spent / received / available, each as total · cash · balance (not cash).
    const row = (label, total, cash) => `<span class="ss-label">${label}</span>${signedAmount(total)}${signedAmount(cash)}${signedAmount(total - cash)}`;
    $('sel-breakdown').innerHTML = `
      <span></span><span class="ss-head">Total</span><span class="ss-head">Cash</span><span class="ss-head">Balance</span>
      ${row('Spent', -out, -outCash)}
      ${row('Received', inn, inCash)}
      ${row('Available', net, inCash - outCash)}`;
  }

  /** Ids of the entries in the list right now: from the rows, or from the day headers in "day totals only". */
  function visibleEntryIds() {
    const rows = [...document.querySelectorAll('#entries .entry-row .row-check input')].map((b) => b.dataset.id);
    if (rows.length || !daysOnly) return rows;
    return [...document.querySelectorAll('#entries .day-sep input[data-ids]')].flatMap((b) => b.dataset.ids.split(','));
  }

  function onRowCheck(event) {
    const box = event.target.closest('.row-check input, #select-all');
    if (!box) return;
    if (box.dataset.dayCheck || box.id === 'select-all') {
      // A day header (or select-all): tick / untick every entry of that day (or of the list).
      // Goes by id, so it also works in "day totals only", where the entry rows aren't shown.
      for (const id of box.id === 'select-all' ? visibleEntryIds() : box.dataset.ids.split(',')) {
        if (box.checked) selectedEntryIds.add(id);
        else selectedEntryIds.delete(id);
        const b = document.querySelector(`#entries .entry-row .row-check input[data-id="${id}"]`);
        if (b) {
          b.checked = box.checked;
          b.closest('.entry-row').classList.toggle('is-selected', box.checked);
        }
      }
    } else {
      if (box.checked) selectedEntryIds.add(box.dataset.id);
      else selectedEntryIds.delete(box.dataset.id);
      box.closest('.entry-row').classList.toggle('is-selected', box.checked);
    }
    renderSelection();
  }

  // You can delete only entries you added, and only while you may still add entries to the list.
  const canDeleteEntry = (e) => {
    const list = findList(e.list_id);
    return isMine(e) && list && canAddEntries(list);
  };

  async function deleteSelected() {
    const chosen = entries.filter((e) => selectedEntryIds.has(e.id));
    const mine = chosen.filter(canDeleteEntry);
    if (!mine.length) return;
    const kept = chosen.length - mine.length;
    let out = 0;
    let inn = 0;
    for (const e of mine) {
      if (e.direction === 'credit') inn += e.amount;
      else out += e.amount;
    }
    const meta = [out && `− ${money.format(out)}`, inn && `+ ${money.format(inn)}`].filter(Boolean).join(' · ');
    const label = `${mine.length} ${mine.length === 1 ? 'entry' : 'entries'}`;
    const ok = await askSheet({
      subject: { icon: '🗑️', name: label, meta },
      title: `Are you sure you want to delete ${mine.length === 1 ? 'this entry' : `these ${label}`}?`,
      message: kept ? `${kept} added by friends will be kept. You can only delete entries you added.` : '',
      confirmText: 'Delete',
      danger: true,
    });
    if (!ok) return;
    const now = nowISO();
    const rows = await Promise.all(mine.map((e) => DB.get('expenses', e.id)));
    await DB.putMany('expenses', rows.filter(Boolean).map((r) => ({ ...r, deleted: true, updated_at: now, synced: 0 })));
    clearSelection();
    await afterWrite();
    toast(`🗑️ ${label} deleted`);
  }

  // ---------- edit several entries at once ----------

  // Your own money entries (not notes) can be changed together; empty = keep each entry's own value.
  const canBulkEdit = (e) => e.kind !== 'note' && canDeleteEntry(e);
  const emptyBulk = () => ({ category: '', pay_via: '', paid_by: '', spend_type: '' });
  let bulk = emptyBulk();

  function openBulkSheet() {
    const chosen = entries.filter((e) => selectedEntryIds.has(e.id));
    const n = chosen.filter(canBulkEdit).length;
    const deletable = chosen.filter(canDeleteEntry).length;
    if (!deletable) return;
    const kept = chosen.length - n;
    const count = (x) => `${x} ${x === 1 ? 'entry' : 'entries'}`;
    bulk = emptyBulk();
    $('bulk-title').textContent = `✏️ Edit ${count(n || deletable)}`;
    $('bulk-hint').textContent = n
      ? 'Pick only what you want to change; everything else stays as it is. Tap a picked option again to undo it.' +
        (kept ? ` ${kept} added by friends or notes won’t change.` : '')
      : 'Notes can’t be changed here, only deleted.';
    // Only notes ticked: nothing to change, just delete.
    $('bulk-fields').hidden = !n;
    $('bulk-apply').hidden = !n;
    $('bulk-delete').textContent = `🗑️ Delete ${count(deletable)}`;
    renderBulkSheet();
    openSheet($('bulk-sheet'));
  }

  function renderBulkSheet() {
    const pill = (field, value, label, extra = '') => {
      const on = bulk[field] === value;
      return `<button type="button" class="pill ${extra} ${on ? 'is-on' : ''}" data-bulk-field="${field}" data-bulk-value="${escapeHtml(value)}" aria-pressed="${on}">${label}</button>`;
    };
    $('bulk-cats').innerHTML = CATEGORIES.map((c) => {
      const on = bulk.category === c.id;
      return `<button type="button" class="chip ${on ? 'chip-active' : ''}" data-bulk-field="category" data-bulk-value="${c.id}" aria-label="${c.label}" aria-pressed="${on}">
        <span class="chip-icon" aria-hidden="true">${c.icon}</span>${chipLabel(c.label)}</button>`;
    }).join('');
    $('bulk-via').innerHTML = getOptions('pay').map((v) => pill('pay_via', v, escapeHtml(v))).join('');
    $('bulk-by').innerHTML = getOptions('people').map((v) => pill('paid_by', v, escapeHtml(v))).join('');
    $('bulk-stype').innerHTML = SPEND_TYPES.map((t) => pill('spend_type', t.id, `${t.icon} ${t.label}`, `stype-${t.id}`)).join('');
    $('bulk-apply').disabled = !Object.values(bulk).some(Boolean);
  }

  function onBulkClick(event) {
    const t = event.target.closest('[data-bulk-field]');
    if (!t) return;
    const { bulkField: field, bulkValue: value } = t.dataset;
    bulk[field] = bulk[field] === value ? '' : value;
    renderBulkSheet();
  }

  async function onBulkSubmit(event) {
    event.preventDefault();
    const patch = Object.fromEntries(Object.entries(bulk).filter(([, v]) => v));
    if (!Object.keys(patch).length) return;
    const mine = entries.filter((e) => selectedEntryIds.has(e.id) && canBulkEdit(e));
    const now = nowISO();
    const rows = (await Promise.all(mine.map((e) => DB.get('expenses', e.id)))).filter(Boolean);
    await DB.putMany(
      'expenses',
      rows.map((r) => {
        const next = { ...r, ...patch, updated_at: now, synced: 0 };
        if (r.direction === 'credit') next.spend_type = ''; // Need / Want / Saving is for money spent
        return next;
      }),
    );
    closeSheet($('bulk-sheet'));
    clearSelection();
    await afterWrite();
    toast(`✏️ ${rows.length} ${rows.length === 1 ? 'entry' : 'entries'} updated`);
  }

  function clearSelection() {
    selectedEntryIds.clear();
    for (const b of document.querySelectorAll('#entries .entry-row .row-check input')) {
      b.checked = false;
      b.closest('.entry-row').classList.remove('is-selected');
    }
    renderSelection();
  }

  function renderListDetail() {
    const list = findList(currentListId);
    if (!list) return;
    const role = roleFor(list);

    let access = '';
    if (role === 'view') access = `👁 View only · shared by ${escapeHtml(sharedBy(list))}`;
    else if (role === 'edit') access = `✏️ You can add entries · shared by ${escapeHtml(sharedBy(list))}`;
    $('list-access').innerHTML = access;
    $('list-access').hidden = !access;
    $('add-entry-btn').hidden = !canAddEntries(list);

    // Month: "Oct 26 (67)" = month and number of entries; defaults to this month. ◀ ▶ step freely.
    const allEntries = entries.filter((e) => e.list_id === list.id);
    const month = shownMonth();
    selectedMonthByList.set(list.id, month);
    monthCounts = new Map();
    for (const e of allEntries) monthCounts.set(e.spent_on.slice(0, 7), (monthCounts.get(e.spent_on.slice(0, 7)) || 0) + 1);
    // Long-list view shows every month, so ◀ ▶ are off and the button reads "All months (N)";
    // picking a month from it switches back to month view.
    const longList = viewMode === 'all';
    const year = month.slice(0, 4);
    const yearCount = [...monthCounts].reduce((t, [ym, n]) => t + (ym.startsWith(year) ? n : 0), 0);
    $('month-label').textContent = longList
      ? `All months (${allEntries.length})`
      : viewMode === 'year' || chartByYear()
        ? `${year} (${yearCount})`
        : `${shortMonth(month)} (${monthCounts.get(month) || 0})`;
    $('month-btn').classList.toggle('is-other-month', !longList && month !== currentMonth());
    $('month-prev').disabled = longList;
    $('month-next').disabled = longList;
    $('view-mode-btn').classList.toggle('is-active', viewMode !== 'month');
    if ($('month-sheet').open) renderMonthSheet();

    // Active filters: badge on 🔍 and a summary bar with ✕ Clear.
    const nFilters = activeFilterCount(filters);
    $('filter-count').hidden = !nFilters;
    $('filter-count').textContent = nFilters;
    $('filter-btn').classList.toggle('is-active', nFilters > 0);
    $('filter-bar').hidden = !nFilters;
    $('filter-summary').innerHTML = nFilters ? `🔍 ${filterSummary(filters)}` : '';

    const inMonth = longList ? allEntries : allEntries.filter((e) => e.spent_on.startsWith(month));
    const filtered = inMonth.filter((e) => matchesFilters(e, filters));

    // Calendar view: day grid for the month, with the chosen day's entries listed below it.
    let calendarHtml = '';
    let shown = filtered;
    let day = '';
    if (viewMode === 'calendar') {
      day = calendarDay(list.id, month, filtered);
      calendarHtml = calendarGridHtml(month, filtered, day);
      shown = filtered.filter((e) => e.spent_on === day);
    } else if (viewMode === 'year') {
      const inYear = allEntries.filter((e) => e.spent_on.startsWith(year) && matchesFilters(e, filters));
      calendarHtml = yearGridHtml(year, inYear, month);
    }
    // Charts view: the chart takes the place of the list (filters still apply).
    if (viewMode === 'chart') {
      selectedEntryIds.clear();
      lastRenderKey = '';
      const chartRows = chartByYear() ? allEntries.filter((e) => e.spent_on.startsWith(year) && matchesFilters(e, filters)) : filtered;
      $('entries').innerHTML = chartCardHtml(month, chartRows);
      renderSelection();
      return;
    }
    // Budget plan view: the whole month (income included), so filters don't apply.
    if (viewMode === 'budget') {
      selectedEntryIds.clear();
      lastRenderKey = '';
      $('entries').innerHTML = budgetCardHtml(month, inMonth);
      renderSelection();
      return;
    }
    const listEntries = sortEntries(shown);
    // Notes of the same period (and day, in calendar view). Money filters hide them; a search still finds them.
    const moneyFilters = filters.type !== 'all' || filters.via.size > 0 || filters.by.size > 0 || filters.cats.size > 0;
    const words = filters.text.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const listNotes = moneyFilters
      ? []
      : notes.filter(
          (n) =>
            n.list_id === list.id &&
            (longList || n.spent_on.startsWith(month)) &&
            (viewMode !== 'calendar' || n.spent_on === day) &&
            words.every((w) => `${n.note} ${noteTypeOf(n.category).label}`.toLowerCase().includes(w)),
        );
    // Date order: notes sit at their date and time. Other orders: notes first (oldest on top).
    const rows = sortMode.startsWith('date-')
      ? sortEntries([...listEntries, ...listNotes])
      : [...[...listNotes].sort(byDate), ...listEntries];
    // Forget selections that are no longer visible (deleted, filtered out, or another month).
    for (const id of [...selectedEntryIds]) if (!listEntries.some((e) => e.id === id)) selectedEntryIds.delete(id);

    // Re-rendering the same view (e.g. after a sync) keeps the scroll position; a new view starts fresh.
    const renderKey = [list.id, viewMode, longList ? '' : month, day, sortMode, daysOnly, filterKey(filters)].join('|');
    const oldRows = document.querySelector('#entries .entry-rows');
    const keep =
      oldRows && renderKey === lastRenderKey
        ? { top: oldRows.scrollTop, height: oldRows.scrollHeight, atBottom: oldRows.scrollHeight - oldRows.scrollTop - oldRows.clientHeight < 4 }
        : null;
    if (renderKey !== lastRenderKey) longListMonths = LONG_LIST_CHUNK;
    lastRenderKey = renderKey;

    if (!rows.length) {
      const [y, m] = month.split('-').map(Number);
      const monthName = longList ? 'any month' : new Date(y, m - 1, 1).toLocaleDateString(LOCALE, { month: 'long', year: 'numeric' });
      $('entries').innerHTML =
        calendarHtml +
        (!allEntries.length
          ? `<p class="empty muted">No entries yet.${canAddEntries(list) ? ' Tap <b>+ Add entry</b> to add one.' : ''}</p>`
          : viewMode === 'calendar'
            ? `<p class="empty muted">No entries on ${formatDay(day)}${activeFilterCount(filters) ? ' that match your filters' : ''}.</p>`
            : inMonth.length
              ? `<p class="empty muted">No entries${longList ? '' : ` in ${monthName}`} match your filters.</p>`
              : `<p class="empty muted">No entries in ${monthName}.</p>`);
      renderSelection();
      return;
    }

    // Long list, sorted by date: chat style. Months are separated by a pinned month chip, the
    // newest is at the bottom (date ↑), and older months load in as you scroll towards them.
    let body;
    longListHasOlder = false;
    const chat = longList && sortMode.startsWith('date-');
    if (chat) {
      const groups = [];
      for (const e of rows) {
        const key = e.spent_on.slice(0, 7);
        if (groups[groups.length - 1]?.key !== key) groups.push({ key, items: [] });
        groups[groups.length - 1].items.push(e);
      }
      const asc = sortMode === 'date-asc';
      const visible = asc ? groups.slice(-longListMonths) : groups.slice(0, longListMonths);
      const hidden = groups.length - visible.length;
      longListHasOlder = hidden > 0;
      const hint = hidden
        ? `<li class="older-hint">${asc ? '↑' : '↓'} Scroll for ${hidden} older ${hidden === 1 ? 'month' : 'months'}</li>`
        : '';
      const html = visible.map((g) => monthSeparatorHtml(g.key, g.items) + rowsWithDayHeaders(g.items)).join('');
      body = asc ? hint + html : html + hint;
    } else if (daysOnly) {
      body = rowsWithDayHeaders(sortMode === 'date-desc' ? rows : [...rows].sort(byDate));
    } else if (sortMode.startsWith('date-') && viewMode !== 'calendar') {
      body = rowsWithDayHeaders(rows); // date order: a thin header above each day
    } else {
      body = rows.map(rowHtml).join('');
    }

    // The header stays put; only the rows scroll.
    $('entries').innerHTML = `${calendarHtml}
      <div class="card entry-table${daysOnly ? ' is-days-only' : ''}">
        <div class="entry-head sort-head">
          <label class="row-check" aria-label="Select all"><input type="checkbox" id="select-all" /></label>
            ${`<button type="button" class="sort-reset${isNormalList() ? ' is-off' : ''}" data-sort-reset title="Back to the normal list (all entries, date oldest first)" aria-label="Reset to normal view"${isNormalList() ? ' tabindex="-1" aria-hidden="true"' : ''}>
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 2.64-6.36"/><path d="M3 4v5h5"/></svg>
            </button>`}
          <div class="sort-icons" role="group" aria-label="Sort entries">${sortIconsHtml()}</div>
        </div>
        <ul class="entry-rows">${body}</ul>
        ${viewMode === 'month' ? monthFooterHtml(listEntries) : ''}
      </div>`;

    const rowsEl = document.querySelector('#entries .entry-rows');
    if (keep) {
      if (prependedOlder) rowsEl.scrollTop = keep.top + (rowsEl.scrollHeight - keep.height); // stay on the same row
      else if (chat && sortMode === 'date-asc' && keep.atBottom) rowsEl.scrollTop = rowsEl.scrollHeight;
      else rowsEl.scrollTop = keep.top;
    } else if (chat && sortMode === 'date-asc') {
      rowsEl.scrollTop = rowsEl.scrollHeight; // open at the newest entry, like a chat
    }
    prependedOlder = false;
    renderSelection();
  }

  /** Month view: Spent · Received · Available (received − spent) of the shown entries. */
  function monthFooterHtml(rows) {
    const { out, inn, outCash, inCash } = moneyTotals(rows);
    const left = inn - out;
    // Each total, then its cash part and the balance part (UPI, bank, cards…) underneath.
    const cell = (label, value, cls, cash, bal) => `
      <div class="ef-cell"><span class="ef-label">${label}</span><strong class="${cls}">${value}</strong>
        <span class="ef-split"><span>Cash ${signedAmount(cash)}</span><span title="Balance (not cash)">Bal ${signedAmount(bal)}</span></span>
      </div>`;
    return `
      <div class="entry-foot" aria-label="Month totals">
        ${cell('Spent', `− ${money.format(out)}`, 'amount-out', -outCash, -(out - outCash))}
        ${cell('Received', `+ ${money.format(inn)}`, 'amount-in', inCash, inn - inCash)}
        ${cell('Available', `${left < 0 ? '− ' : ''}${money.format(Math.abs(left))}`, left < 0 ? 'amount-out' : 'amount-in', inCash - outCash, inn - inCash - (out - outCash))}
      </div>`;
  }

  // ---------- charts view ----------

  const CHART_KEY = 'myExpenses.chart';
  const CHART_VIEWS = [
    { id: 'category', label: '🏷️ Category' },
    { id: 'method', label: '💳 Payment method' },
    { id: 'daily', label: '📅 Over time' },
  ];
  const CHART_SHAPES = [
    { id: 'donut', label: 'Donut' },
    { id: 'pie', label: 'Pie' },
    { id: 'bars', label: 'Bar' },
    { id: 'column', label: 'Column' },
  ];
  // Shapes that make sense for each view; the first is used when the chosen shape doesn't fit.
  const VIEW_SHAPES = {
    category: ['donut', 'pie', 'bars', 'column'],
    method: ['donut', 'pie', 'bars', 'column'],
    daily: ['column', 'bars'],
  };
  const CHART_PERIODS = [
    { id: 'month', label: 'Month' },
    { id: 'year', label: 'Year' },
  ];
  const CHART_SLOTS = 7; // categorical colours --s1…--s7; the rest fold into "Other"
  const chartState = { view: 'category', shape: 'donut', period: 'month', ...storage((s) => JSON.parse(s.getItem(CHART_KEY) || '{}')) };
  if (!VIEW_SHAPES[chartState.view]) chartState.view = 'category'; // e.g. a saved view that no longer exists
  const chartShape = () => {
    const ok = VIEW_SHAPES[chartState.view] || VIEW_SHAPES.category;
    return ok.includes(chartState.shape) ? chartState.shape : ok[0];
  };
  // Charts can cover the shown month or its whole year; ◀ ▶ and the month button follow.
  const chartByYear = () => viewMode === 'chart' && chartState.period === 'year';
  const periodWord = () => (chartState.period === 'year' ? 'this year' : 'this month');

  function setChart(patch) {
    Object.assign(chartState, patch);
    storage((s) => s.setItem(CHART_KEY, JSON.stringify(chartState)));
    renderListDetail();
  }

  const pctLabel = (v, total) => {
    const p = (v / total) * 100;
    return p > 0 && p < 1 ? '<1%' : `${Math.round(p)}%`;
  };

  /** Pie / donut of { label, value, color } slices; a donut shows `center` in its hole. Marks carry a tap / hover tip. */
  function donutHtml(slices, { pie = false, size = 168, center = '' } = {}) {
    const total = slices.reduce((t, s) => t + s.value, 0);
    const c = size / 2;
    const r = c - 1;
    const inner = pie ? 0 : r * 0.62;
    const pt = (a, rad) => `${(c + rad * Math.sin(a)).toFixed(2)} ${(c - rad * Math.cos(a)).toFixed(2)}`;
    let a0 = 0;
    const marks = slices.map((s, i) => {
      const tip = escapeHtml(`${s.label}: ${money.format(s.value)} · ${pctLabel(s.value, total)}`);
      const attrs = `fill="${s.color}" class="chart-mark" data-tip="${tip}" data-slice="${i}"`;
      if (s.value >= total) {
        // One slice is the whole circle (an arc can't start and end at the same point).
        return inner
          ? `<path ${attrs} fill-rule="evenodd" d="M${c} ${c - r}a${r} ${r} 0 1 1 0 ${2 * r}a${r} ${r} 0 1 1 0 ${-2 * r}ZM${c} ${c - inner}a${inner} ${inner} 0 1 0 0 ${2 * inner}a${inner} ${inner} 0 1 0 0 ${-2 * inner}Z"><title>${tip}</title></path>`
          : `<circle ${attrs} cx="${c}" cy="${c}" r="${r}"><title>${tip}</title></circle>`;
      }
      const a1 = a0 + (s.value / total) * 2 * Math.PI;
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const d = inner
        ? `M${pt(a0, r)}A${r} ${r} 0 ${large} 1 ${pt(a1, r)}L${pt(a1, inner)}A${inner} ${inner} 0 ${large} 0 ${pt(a0, inner)}Z`
        : `M${c} ${c}L${pt(a0, r)}A${r} ${r} 0 ${large} 1 ${pt(a1, r)}Z`;
      a0 = a1;
      return `<path ${attrs} d="${d}"><title>${tip}</title></path>`;
    });
    return `
      <div class="chart-donut" style="width:${size}px;height:${size}px">
        <svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true">${marks.join('')}</svg>
        ${center && inner ? `<div class="chart-center">${center}</div>` : ''}
      </div>`;
  }

  /**
   * Category / payment method: share of spending (or of money received, with the "+ Received" filter) per group.
   * `groupOf(e)` gives { key, label, icon, short } — `short` labels the axis of a column chart.
   */
  function groupChartHtml(rows, groupOf) {
    const dir = filters.type === 'received' ? 'credit' : 'debit';
    const byKey = new Map();
    for (const e of rows) {
      if (e.direction !== dir) continue;
      const g = groupOf(e);
      const t = byKey.get(g.key) || { ...g, value: 0, n: 0 };
      t.value += e.amount;
      t.n++;
      byKey.set(g.key, t);
    }
    const sorted = [...byKey.values()].sort((a, b) => b.value - a.value);
    if (!sorted.length) return `<p class="empty muted">No ${dir === 'credit' ? 'money received' : 'spending'} to chart ${periodWord()}.</p>`;
    // Biggest first in fixed colour order; past the palette, the rest fold into one grey "Other".
    const many = sorted.length > CHART_SLOTS + 1;
    // (With exactly one group past the palette it keeps its own row, in the "Other" grey.)
    const slices = (many ? sorted.slice(0, CHART_SLOTS) : sorted).map((t, i) => ({ ...t, color: i < CHART_SLOTS ? `var(--s${i + 1})` : 'var(--s-other)' }));
    if (many) {
      const rest = sorted.slice(CHART_SLOTS);
      slices.push({ label: 'Other', icon: '➕', short: 'Other', value: rest.reduce((t, x) => t + x.value, 0), n: rest.reduce((t, x) => t + x.n, 0), color: 'var(--s-other)' });
    }
    const total = slices.reduce((t, s) => t + s.value, 0);
    const sign = dir === 'credit' ? '+' : '−';
    const max = slices[0].value;
    const shape = chartShape();
    const bars = shape === 'bars';
    // Each row carries its full numbers, so tapping a slice / column just highlights its row (data-slice links them).
    const legend = slices
      .map((s, i) => {
        const tip = escapeHtml(`${s.label}: ${money.format(s.value)} · ${pctLabel(s.value, total)} · ${s.n} ${s.n === 1 ? 'entry' : 'entries'}`);
        return `
        <li class="cl-row" data-tip="${tip}" data-slice="${i}">
          <span class="cl-swatch" style="background:${s.color}" aria-hidden="true"></span>
          <span class="cl-name"><span aria-hidden="true">${s.icon}</span> ${escapeHtml(s.label)} <span class="cl-n">· ${s.n} ${s.n === 1 ? 'entry' : 'entries'}</span></span>
          <span class="cl-value">${sign} ${money.format(s.value)}</span>
          <span class="cl-pct">${pctLabel(s.value, total)}</span>
          ${bars ? `<span class="cl-bar"><span style="width:${((s.value / max) * 100).toFixed(1)}%;background:${s.color}"></span></span>` : ''}
        </li>`;
      })
      .join('');
    const center = `<span class="cc-label">${dir === 'credit' ? 'Received' : 'Spent'}</span><strong>${sign} ${moneyWhole.format(total)}</strong>`;
    if (shape === 'column') {
      const points = slices.map((s, i) => ({
        slice: i,
        axis: s.short,
        value: s.value,
        color: s.color,
        tip: `${s.label}: ${sign} ${money.format(s.value)} · ${pctLabel(s.value, total)}`,
      }));
      return `
        ${columnChartHtml(points, { isIn: dir === 'credit', label: `${dir === 'credit' ? 'Received' : 'Spent'} by group` })}
        <ul class="chart-legend">${legend}</ul>
        <p class="chart-note muted small">Total ${sign} ${money.format(total)}</p>`;
    }
    return `
      <div class="chart-body">
        ${bars ? '' : donutHtml(slices, { pie: shape === 'pie', center })}
        <ul class="chart-legend${bars ? ' is-bars' : ''}">${legend}</ul>
      </div>
      ${bars ? `<p class="chart-note muted small">Total ${sign} ${money.format(total)}</p>` : ''}`;
  }

  const categoryGroup = (e) => {
    const cat = categoryOf(e.category);
    return { key: e.category, label: cat.label, icon: cat.icon, short: cat.icon };
  };
  const methodGroup = (e) => {
    const via = (e.pay_via || '').trim() || 'Not set';
    return { key: via.toLowerCase(), label: via, icon: isCash(e) ? '💵' : '💳', short: via.length > 7 ? `${via.slice(0, 6)}…` : via };
  };

  /**
   * Column chart of { axis, value, tip, color? } points on one scale, with an axis label under each point,
   * an optional dashed average line, and a full-height tap / hover area per point.
   */
  function columnChartHtml(points, { isIn = false, avg = null, label = '' } = {}) {
    const n = points.length;
    const max = Math.max(...points.map((p) => p.value)) || 1;
    const W = 320;
    const H = 150;
    const padTop = 16;
    const padBottom = 18;
    const plotH = H - padTop - padBottom;
    const slot = W / n;
    const bw = Math.max(2, Math.min(slot - 3, 40));
    const base = padTop + plotH;
    const yOf = (v) => base - (v / max) * plotH;
    const cx = (i) => (i + 0.5) * slot;
    const fill = (p) => (p.color ? ` style="fill:${p.color}"` : '');
    const marks = points
      .map((p, i) => {
        const tip = escapeHtml(p.tip);
        let mark = '';
        if (p.value) {
          const x = cx(i) - bw / 2;
          const h = (p.value / max) * plotH;
          const rr = Math.min(4, bw / 2, h);
          // Bar with rounded top corners, square on the baseline.
          mark = `<path class="cd-bar"${fill(p)} d="M${x.toFixed(2)} ${base}V${(base - h + rr).toFixed(2)}Q${x.toFixed(2)} ${(base - h).toFixed(2)} ${(x + rr).toFixed(2)} ${(base - h).toFixed(2)}H${(x + bw - rr).toFixed(2)}Q${(x + bw).toFixed(2)} ${(base - h).toFixed(2)} ${(x + bw).toFixed(2)} ${(base - h + rr).toFixed(2)}V${base}Z"/>`;
        }
        return `<g class="cd-day" data-tip="${tip}"${p.slice == null ? '' : ` data-slice="${p.slice}"`}><title>${tip}</title><rect x="${(i * slot).toFixed(2)}" y="0" width="${slot.toFixed(2)}" height="${H}" fill="transparent"/>${mark}</g>`;
      })
      .join('');
    // A label under every point (smaller when there are many, e.g. the days of a month).
    const ticks = points
      .map((p, i) => `<text class="cd-axis${n > 16 ? ' cd-day-num' : ''}" x="${cx(i).toFixed(2)}" y="${H - 5}" text-anchor="middle">${escapeHtml(p.axis)}</text>`)
      .join('');
    const avgLine = avg == null ? '' : `<line class="cd-avg" x1="0" x2="${W}" y1="${yOf(avg).toFixed(2)}" y2="${yOf(avg).toFixed(2)}"/>`;
    return `
      <svg class="chart-daily ${isIn ? 'is-in' : ''}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeHtml(label)}">
        <line class="cd-grid" x1="0" x2="${W}" y1="${padTop}" y2="${padTop}"/>
        <text class="cd-axis" x="0" y="${padTop - 5}">${moneyWhole.format(max)}</text>
        <line class="cd-base" x1="0" x2="${W}" y1="${base}" y2="${base}"/>
        ${marks}
        ${avgLine}
        ${ticks}
      </svg>`;
  }

  /**
   * Over time: spending (or money received, with the "+ Received" filter) on each day of the month,
   * or in each month of the year.
   */
  function timeChartHtml(month, rows) {
    const dir = filters.type === 'received' ? 'credit' : 'debit';
    const byYear = chartState.period === 'year';
    const [y, m] = month.split('-').map(Number);
    const n = byYear ? 12 : new Date(y, m, 0).getDate();
    const per = Array(n).fill(0);
    for (const e of rows) if (e.direction === dir) per[Number(byYear ? e.spent_on.slice(5, 7) : e.spent_on.slice(8, 10)) - 1] += e.amount;
    const max = Math.max(...per);
    if (!max) return `<p class="empty muted">No ${dir === 'credit' ? 'money received' : 'spending'} to chart ${periodWord()}.</p>`;
    const total = per.reduce((t, v) => t + v, 0);
    // Average over the days (months) so far this month (year); the whole period for past ones.
    const today = todayISO();
    const soFar = byYear
      ? String(y) === today.slice(0, 4) ? Number(today.slice(5, 7)) : 12
      : month === today.slice(0, 7) ? Number(today.slice(8, 10)) : n;
    const avg = total / soFar;
    const top = per.indexOf(max);
    const sign = dir === 'credit' ? '+' : '−';
    const name = (i) => (byYear ? longMonth(`${y}-${pad2(i + 1)}`) : formatDay(`${month}-${pad2(i + 1)}`));
    const axis = (i) => (byYear ? new Date(y, i, 1).toLocaleDateString(LOCALE, { month: 'short' }) : String(i + 1));
    const unit = byYear ? 'month' : 'day';
    let visual;
    if (chartShape() === 'bars') {
      // One horizontal bar per day / month that has an amount.
      visual = `<ul class="chart-legend is-bars${dir === 'credit' ? ' is-in' : ''}">${per
        .map((v, i) => {
          if (!v) return '';
          const tip = escapeHtml(`${name(i)}: ${sign} ${money.format(v)}`);
          return `
          <li class="cl-row" data-tip="${tip}">
            <span class="cl-swatch cd-hbar" aria-hidden="true"></span>
            <span class="cl-name">${escapeHtml(name(i))}</span>
            <span class="cl-value">${sign} ${money.format(v)}</span>
            <span class="cl-pct">${pctLabel(v, total)}</span>
            <span class="cl-bar"><span class="cd-hbar" style="width:${((v / max) * 100).toFixed(1)}%"></span></span>
          </li>`;
        })
        .join('')}</ul>`;
    } else {
      const points = per.map((v, i) => ({ axis: axis(i), value: v, tip: `${name(i)}: ${v ? `${sign} ${money.format(v)}` : 'nothing'}` }));
      visual = columnChartHtml(points, {
        isIn: dir === 'credit',
        avg,
        label: `${dir === 'credit' ? 'Received' : 'Spent'} per ${unit}, highest ${money.format(max)} in ${name(top)}`,
      });
    }
    return `
      ${visual}
      <div class="cd-stats">
        <span>Total <b class="${dir === 'credit' ? 'amount-in' : 'amount-out'}">${sign} ${money.format(total)}</b></span>
        <span><span class="cd-avg-key" aria-hidden="true"></span>Avg <b>${money.format(avg)}</b>/${unit}</span>
        <span>Top <b>${escapeHtml(name(top))}</b></span>
      </div>`;
  }

  /** Charts view: what to chart, the shape, the chart, and (over time) a line that shows the tapped mark. */
  function chartCardHtml(month, rows) {
    const pills = (items, attr, on) =>
      items.map((x) => `<button type="button" class="pill ${x.id === on ? 'is-on' : ''}" ${attr}="${x.id}" aria-pressed="${x.id === on}">${x.label}</button>`).join('');
    const body =
      chartState.view === 'daily' ? timeChartHtml(month, rows) : groupChartHtml(rows, chartState.view === 'method' ? methodGroup : categoryGroup);
    const shapes = CHART_SHAPES.filter((x) => VIEW_SHAPES[chartState.view].includes(x.id));
    return `
      <div class="card chart-card">
        <div class="chart-tabs" role="group" aria-label="What to chart">${pills(CHART_VIEWS, 'data-chart-view', chartState.view)}</div>
        <div class="chart-opts">
          <div class="chart-shapes" role="group" aria-label="Period">${pills(CHART_PERIODS, 'data-chart-period', chartState.period)}</div>
          <div class="chart-shapes" role="group" aria-label="Chart type">${pills(shapes, 'data-chart-shape', chartShape())}</div>
        </div>
        ${body}
        ${chartState.view === 'daily' ? '<p id="chart-tip" class="chart-tip muted small" aria-live="polite">Tap the chart to see an amount.</p>' : ''}
      </div>`;
  }

  // ---------- budget plan view ----------

  // One fixed 50 · 30 · 20 plan: the month's income split into Needs, Wants and Savings. Each spent entry counts in
  // the bucket of its expense type (Need / Want / Saving, set on the entry); entries without a type show as "Not set".
  // Needs and Wants are limits (spend up to); Savings is a goal (put away at least).
  const BUDGET_BUCKETS = [
    { id: 'need', label: 'Needs', pct: 50, kind: 'limit', color: 'var(--s1)' },
    { id: 'want', label: 'Wants', pct: 30, kind: 'limit', color: 'var(--s4)' },
    { id: 'saving', label: 'Savings', pct: 20, kind: 'goal', color: 'var(--s3)' },
  ];
  const BUDGET_KIND_LABELS = { limit: 'Spend up to', goal: 'Save at least' };
  const BUDGET_INFO = `The 50 · 30 · 20 rule splits the money you receive in a month into three parts:

🛒 Needs 50%: must-pay costs like rent, bills, groceries, EMIs, transport and health. Spend up to this.
🛍️ Wants 30%: nice-to-haves like eating out, shopping, trips and fun. Spend up to this.
💰 Savings 20%: savings, investments and extra loan payments. Put away at least this.

Each spent entry counts in the part you pick for it (Need, Want or Saving) when you add or edit it.`;

  /** Income (money received in the month), the plan's amount per bucket and what went to each. */
  function budgetNumbers(rows) {
    const actual = Object.fromEntries(BUDGET_BUCKETS.map((b) => [b.id, 0]));
    let income = 0;
    let out = 0;
    let unset = 0;
    for (const e of rows) {
      if (e.kind === 'note') continue;
      if (e.direction === 'credit') {
        income += e.amount;
        continue;
      }
      out += e.amount;
      const t = spendTypeOf(e)?.id;
      if (t in actual) actual[t] += e.amount;
      else unset += e.amount;
    }
    const target = Object.fromEntries(BUDGET_BUCKETS.map((b) => [b.id, (income * b.pct) / 100]));
    return { income, out, unset, actual, target };
  }

  const pctOf = (v, income) => (income ? `${Math.round((v / income) * 100)}%` : '—');

  /** Plan (pale) and actual (coloured) column per bucket, on one scale. */
  function budgetColumnsHtml(buckets, n) {
    const W = 320;
    const H = 160;
    const padTop = 16;
    const padBottom = 20;
    const plotH = H - padTop - padBottom;
    const base = padTop + plotH;
    const max = Math.max(1, ...buckets.flatMap((b) => [n.target[b.id], Math.max(0, n.actual[b.id])]));
    const slot = W / buckets.length;
    const bw = Math.min(28, slot / 2 - 4);
    const bar = (x, v, cls, color) => {
      const h = (Math.max(0, v) / max) * plotH;
      return h ? `<rect class="${cls}" x="${x.toFixed(2)}" y="${(base - h).toFixed(2)}" width="${bw.toFixed(2)}" height="${h.toFixed(2)}" rx="3" style="--c:${color}"/>` : '';
    };
    const groups = buckets
      .map((b, i) => {
        const x0 = i * slot + slot / 2;
        const tip = escapeHtml(`${b.label}: ${money.format(n.actual[b.id])} (${pctOf(n.actual[b.id], n.income)}) · plan ${money.format(n.target[b.id])}`);
        return `<g class="cd-day" data-tip="${tip}" data-slice="${i}"><title>${tip}</title>
        <rect x="${(i * slot).toFixed(2)}" y="0" width="${slot.toFixed(2)}" height="${H}" fill="transparent"/>
        ${bar(x0 - bw - 1.5, n.target[b.id], 'bp-col-plan', b.color)}${bar(x0 + 1.5, n.actual[b.id], 'bp-col-actual', b.color)}
        <text class="cd-axis" x="${x0.toFixed(2)}" y="${H - 5}" text-anchor="middle">${escapeHtml(b.label)}</text></g>`;
      })
      .join('');
    return `
      <svg class="chart-daily" viewBox="0 0 ${W} ${H}" role="img" aria-label="Plan and actual per bucket">
        <line class="cd-grid" x1="0" x2="${W}" y1="${padTop}" y2="${padTop}"/>
        <text class="cd-axis" x="0" y="${padTop - 5}">${moneyWhole.format(max)}</text>
        <line class="cd-base" x1="0" x2="${W}" y1="${base}" y2="${base}"/>
        ${groups}
      </svg>
      <p class="bp-key muted small"><span class="bp-key-plan" aria-hidden="true"></span>Plan <span class="bp-key-actual" aria-hidden="true"></span>Actual</p>`;
  }

  /** Plan (pale) and actual (coloured) horizontal bar per bucket, on one scale. */
  function budgetBarsHtml(buckets, n) {
    const max = Math.max(1, ...buckets.flatMap((b) => [n.target[b.id], Math.max(0, n.actual[b.id])]));
    const w = (v) => `${((Math.max(0, v) / max) * 100).toFixed(1)}%`;
    const rows = buckets
      .map((b, i) => {
        const tip = escapeHtml(`${b.label}: ${money.format(n.actual[b.id])} (${pctOf(n.actual[b.id], n.income)}) · plan ${money.format(n.target[b.id])}`);
        return `
        <div class="bp-hbar-row" data-tip="${tip}" data-slice="${i}" title="${tip}">
          <span class="bp-hbar-label">${escapeHtml(b.label)}</span>
          <span class="bp-hbars" style="--c:${b.color}">
            <span class="bp-hbar is-plan" style="width:${w(n.target[b.id])}"></span>
            <span class="bp-hbar" style="width:${w(n.actual[b.id])}"></span>
          </span>
        </div>`;
      })
      .join('');
    return `
      <div class="bp-hbar-chart">${rows}</div>
      <p class="bp-key muted small"><span class="bp-key-plan" aria-hidden="true"></span>Plan <span class="bp-key-actual" aria-hidden="true"></span>Actual</p>`;
  }

  /** Budget plan view: income · spent · left, a donut, pie, bar or column chart, and each bucket against its plan. */
  function budgetCardHtml(month, rows) {
    const n = budgetNumbers(rows);
    const BUDGET_SHAPES = [
      { id: 'donut', label: 'Donut' },
      { id: 'pie', label: 'Pie' },
      { id: 'bars', label: 'Bar' },
      { id: 'column', label: 'Column' },
    ];
    const shape = BUDGET_SHAPES.some((x) => x.id === chartState.budgetShape) ? chartState.budgetShape : 'donut';
    const shapes = BUDGET_SHAPES
      .map((x) => `<button type="button" class="pill ${x.id === shape ? 'is-on' : ''}" data-budget-shape="${x.id}" aria-pressed="${x.id === shape}">${x.label}</button>`)
      .join('');
    const split = BUDGET_BUCKETS.map((b) => `${b.label} ${b.pct}`).join(' · ');
    const head = `
      <div class="bp-head">
        <div><strong>🎯 50 · 30 · 20 Rule</strong><span class="muted small">${split}</span></div>
        <button type="button" class="bp-info-btn" data-action="budget-info" aria-label="About the 50 · 30 · 20 rule" title="About the 50 · 30 · 20 rule">i</button>
      </div>`;
    if (!n.income && !n.out) {
      return `<div class="card chart-card budget-card">${head}<p class="empty muted">No income or spending in ${longMonth(month)} yet.</p></div>`;
    }
    const left = n.income - n.out;
    const summary = `
      <div class="bp-summary">
        <div><span class="ef-label">Income</span><strong class="amount-in">${money.format(n.income)}</strong><span class="muted small">100%</span></div>
        <div><span class="ef-label">Spent</span><strong class="amount-out">${money.format(n.out)}</strong><span class="muted small">${pctOf(n.out, n.income)}</span></div>
        <div><span class="ef-label">Left</span><strong class="${left < 0 ? 'amount-out' : 'amount-in'}">${left < 0 ? '− ' : ''}${money.format(Math.abs(left))}</strong><span class="muted small">${pctOf(left, n.income)}</span></div>
      </div>`;
    let visual;
    if (shape === 'column') {
      visual = budgetColumnsHtml(BUDGET_BUCKETS, n);
    } else if (shape === 'bars') {
      visual = budgetBarsHtml(BUDGET_BUCKETS, n);
    } else {
      // Where the spending went, with entries that have no expense type as "Not set".
      const slices = [
        ...BUDGET_BUCKETS.map((b) => ({ label: b.label, value: n.actual[b.id], color: b.color })),
        { label: 'Not set', value: n.unset, color: 'var(--s-other)' },
      ].filter((s) => s.value > 0);
      const center = `<span class="cc-label">Income</span><strong>${moneyWhole.format(n.income)}</strong>`;
      visual = slices.length ? `<div class="chart-body">${donutHtml(slices, { pie: shape === 'pie', center })}</div>` : '';
    }
    const items = BUDGET_BUCKETS.map((b, i) => {
      const act = n.actual[b.id];
      const tgt = n.target[b.id];
      const limit = b.kind === 'limit';
      // A limit should stay under plan; a goal should reach it.
      const off = limit ? act > tgt : act < tgt;
      const gap = Math.abs(tgt - act);
      const status = limit
        ? off ? `Over by ${money.format(gap)}` : `${money.format(gap)} left`
        : off ? `${money.format(gap)} to goal` : `Goal reached${act > tgt ? ` · + ${money.format(act - tgt)}` : ''}`;
      const fill = tgt > 0 ? Math.min(100, (act / tgt) * 100) : act > 0 ? 100 : 0;
      const tip = escapeHtml(`${b.label}: ${money.format(act)} (${pctOf(act, n.income)}) · plan ${b.pct}% = ${money.format(tgt)}`);
      return `
        <li class="bp-row ${off ? (limit ? 'is-over' : 'is-short') : ''}" data-tip="${tip}" data-slice="${i}">
          <span class="cl-swatch" style="background:${b.color}" aria-hidden="true"></span>
          <span class="bp-name">${b.label} <span class="muted small">${BUDGET_KIND_LABELS[b.kind]}</span></span>
          <span class="bp-amt">${money.format(act)}</span>
          <span class="bp-bar"><span style="width:${fill.toFixed(1)}%;background:${b.color}"></span><b class="bp-bar-pct">${pctOf(act, n.income)}</b></span>
          <span class="bp-plan muted small">Plan ${b.pct}% · ${money.format(tgt)}</span>
          <span class="bp-status small">${status}</span>
        </li>`;
    }).join('');
    const unsetRow = n.unset
      ? `
        <li class="bp-row is-unset">
          <span class="cl-swatch" style="background:var(--s-other)" aria-hidden="true"></span>
          <span class="bp-name">Not set</span>
          <span class="bp-amt">${money.format(n.unset)} <b>${pctOf(n.unset, n.income)}</b></span>
          <span class="bp-plan muted small">Spent entries with no Need / Want / Saving type</span>
        </li>`
      : '';
    return `
      <div class="card chart-card budget-card">
        ${head}
        ${summary}
        <div class="chart-shapes" role="group" aria-label="Chart type">${shapes}</div>
        ${visual}
        <ul class="bp-list">${items}${unsetRow}</ul>
      </div>`;
  }

  // ---------- long list (chat style) & calendar helpers ----------

  const LONG_LIST_CHUNK = 3; // months rendered at a time in the long list
  let longListMonths = LONG_LIST_CHUNK;
  let longListHasOlder = false;
  let prependedOlder = false;
  let lastRenderKey = '';
  const compactNumber = new Intl.NumberFormat(LOCALE, { notation: 'compact', maximumFractionDigits: 1 });
  const filterKey = (f) => [f.type, [...f.via].join(','), [...f.by].join(','), [...f.cats].join(','), f.text.trim()].join('~');

  /** Long list: when scrolled near the older end, render more months (keeping the current row in place). */
  function onRowsScroll(event) {
    if (viewMode !== 'all' || !longListHasOlder || !event.target.classList?.contains('entry-rows')) return;
    const el = event.target;
    const asc = sortMode === 'date-asc';
    const nearOlderEnd = asc ? el.scrollTop < 80 : el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (!nearOlderEnd) return;
    longListMonths += LONG_LIST_CHUNK;
    prependedOlder = asc;
    renderListDetail();
  }

  const rowHtml = (e) => (e.kind === 'note' ? noteRowHtml(e) : entryRowHtml(e));

  // Notes are written as plain text; when shown in the list they're coloured automatically:
  // −/+ amounts red / green, other amounts bold, and money words by meaning.
  const NOTE_WORDS = {
    out: 'spend|spent|spending|paid|pay|payment|rent|emi|loan|bills?|expenses?|debit(?:ed)?(?!\\s+card)|withdrawal|withdrawl|withdraw|sent|send|fees?|charges?|petrol|fuel|shopping|cost',
    in: 'received?|receiving|salary|income|credit(?:ed)?(?!\\s+card)|refund(?:ed)?|cashback|available|balance|savings?|saved|bonus|profit|interest',
    warn: 'due|pending|reminder|remind|owe[sd]?|lent|borrow(?:ed)?|remember|todo|deadline|overdue|urgent',
    info: 'credit\\s+card|debit\\s+card|bank|cash|upi|card|wallet|transfer|total|budget|plan|limit',
  };
  const NOTE_TOKEN = new RegExp(
    [
      // signed amount: "-2344", "+3,245.50", "−₹500", "/-2344" (not part of a date like 2026-10-01)
      '(?<sign>(?<![\\w.,&#])[+\\-−]\\s?(?:₹|rs\\.?\\s?|inr\\s?)?\\d(?:[\\d,]*\\d)?(?:\\.\\d+)?)',
      // plain amount: "555", "₹1,200", "Rs 300", each part of "8000+4300" (not times like 10:30 or dates like 01/10/2026)
      '(?<num>(?<![\\w/:.,&#\\-−])(?:₹\\s?|rs\\.?\\s?|inr\\s?)?\\d(?:[\\d,]*\\d)?(?:\\.\\d+)?(?![\\w/:]|\\.\\d|[-−]\\d))',
      ...Object.entries(NOTE_WORDS).map(([k, w]) => `(?<${k}>\\b(?:${w})\\b)`),
    ].join('|'),
    'gi',
  );

  function highlightNote(text) {
    return escapeHtml(text).replace(NOTE_TOKEN, (m, ...args) => {
      const g = args[args.length - 1];
      if (g.sign) return `<span class="nt nt-amt nt-${/^[-−]/.test(m) ? 'out' : 'in'}">${m}</span>`;
      if (g.num) return /^\d{1,2}$/.test(m) ? m : `<span class="nt nt-amt">${m}</span>`; // 1–2 digit numbers stay plain
      const kind = ['out', 'in', 'warn', 'info'].find((k) => g[k]);
      return `<span class="nt nt-${kind}">${m}</span>`;
    });
  }

  /**
   * A note: highlighted one-liner (type · date · first line). Tap to expand to the
   * full text, with Edit / Delete for your own notes.
   */
  function noteRowHtml(n) {
    const t = noteTypeOf(n.category);
    const open = openNoteIds.has(n.id);
    const list = findList(n.list_id);
    const editable = isMine(n) && list && canAddEntries(list);
    const by = list && listMembers(list.id).length && !isMine(n) ? ` · by ${escapeHtml(n.author_name || 'a friend')}` : '';
    const [first, ...rest] = n.note.split('\n');
    const more = rest.join('\n').trim();
    return `
      <li class="note-row note-${t.id} ${open ? 'is-open' : ''}">
        <button type="button" class="note-head" data-action="toggle-note" data-id="${n.id}" aria-expanded="${open}">
          <span class="note-icon" aria-hidden="true">${t.icon}</span>
          <span class="note-main">
            <span class="note-meta">${t.label} · ${formatWhen(n.spent_on, entryTime(n))}${by}</span>
            <span class="note-first">${highlightNote(first)}</span>
          </span>
          <span class="note-chev" aria-hidden="true">▾</span>
        </button>
        ${
          open
            ? `<div class="note-more">
                ${more ? `<p class="note-text">${highlightNote(more)}</p>` : ''}
                ${
                  editable
                    ? `<div class="note-actions">
                        <button type="button" class="note-act note-edit" data-action="edit-note" data-id="${n.id}">
                          <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                          Edit
                        </button>
                        <button type="button" class="note-act note-delete" data-action="delete-note" data-id="${n.id}">
                          <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                          Delete
                        </button>
                      </div>`
                    : ''
                }
              </div>`
            : ''
        }
      </li>`;
  }

  /** Rows (already in date order) with a "Sunday, 11/10/26 · − ₹x · + ₹y" header before each day. */
  function rowsWithDayHeaders(items) {
    let html = '';
    for (let i = 0; i < items.length; ) {
      const day = items[i].spent_on;
      let j = i;
      while (j < items.length && items[j].spent_on === day) j++;
      html += daySeparatorHtml(day, items.slice(i, j)) + (daysOnly ? '' : items.slice(i, j).map(rowHtml).join(''));
      i = j;
    }
    return html;
  }

  function daySeparatorHtml(day, items) {
    let out = 0;
    let inn = 0;
    for (const e of items) {
      if (e.kind === 'note') continue;
      if (e.direction === 'credit') inn += e.amount;
      else out += e.amount;
    }
    const [y, m, d] = day.split('-').map(Number);
    const weekday = new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'long' });
    const label = `${weekday}, ${d}/${pad2(m)}/${String(y).slice(-2)}`;
    const isToday = day === todayISO();
    const hasEntries = items.some((e) => e.kind !== 'note');
    const ids = items.filter((e) => e.kind !== 'note').map((e) => e.id).join(',');
    return `
      <li class="day-sep ${isToday ? 'is-today' : ''}" aria-label="${label}">
        ${hasEntries ? `<label class="row-check day-check" aria-label="Select all entries of ${label}"><input type="checkbox" data-day-check="${day}" data-ids="${ids}" /></label>` : '<span class="day-check" aria-hidden="true"></span>'}
        <span class="day-name">${label}${isToday ? ' <span class="day-today">Today</span>' : ''}</span>
        <span class="day-totals">${out ? `<span class="amount-out">− ${money.format(out)}</span>` : ''}${out && inn ? ' · ' : ''}${inn ? `<span class="amount-in">+ ${money.format(inn)}</span>` : ''}</span>
      </li>`;
  }

  function monthSeparatorHtml(key, items) {
    let out = 0;
    let inn = 0;
    for (const e of items) {
      if (e.kind === 'note') continue;
      if (e.direction === 'credit') inn += e.amount;
      else out += e.amount;
    }
    const [y, m] = key.split('-').map(Number);
    const name = new Date(y, m - 1, 1).toLocaleDateString(LOCALE, { month: 'long', year: 'numeric' });
    return `
      <li class="month-sep" aria-label="${name}">
        <span class="month-chip">${name}${out ? ` · <span class="amount-out">− ${money.format(out)}</span>` : ''}${inn ? ` · <span class="amount-in">+ ${money.format(inn)}</span>` : ''}</span>
      </li>`;
  }

  const selectedDayByList = new Map(); // list id → 'YYYY-MM-DD' chosen in the calendar

  /** The calendar's chosen day: kept per list; otherwise today (this month) or the latest day with entries. */
  function calendarDay(listId, month, monthEntriesList) {
    let day = selectedDayByList.get(listId);
    if (!day || !day.startsWith(month)) {
      const latest = monthEntriesList.reduce((max, e) => (e.spent_on > max ? e.spent_on : max), '');
      day = todayISO().startsWith(month) ? todayISO() : latest || `${month}-01`;
    }
    selectedDayByList.set(listId, day);
    return day;
  }

  /** Monday-first month grid; each day shows its spent (red) and received (green) totals in short form. */
  /** Year view: the 12 months of `year` with what was spent / received in each; `month` is highlighted. */
  function yearGridHtml(year, yearEntries, month) {
    const totals = new Map(); // 'YYYY-MM' → { out, in, n }
    let yearOut = 0;
    let yearIn = 0;
    for (const e of yearEntries) {
      const key = e.spent_on.slice(0, 7);
      const t = totals.get(key) || { out: 0, in: 0, n: 0 };
      if (e.direction === 'credit') {
        t.in += e.amount;
        yearIn += e.amount;
      } else {
        t.out += e.amount;
        yearOut += e.amount;
      }
      t.n++;
      totals.set(key, t);
    }
    const thisMonth = currentMonth();
    const cells = Array.from({ length: 12 }, (_, i) => {
      const key = `${year}-${pad2(i + 1)}`;
      const t = totals.get(key);
      const name = new Date(+year, i, 1).toLocaleDateString(LOCALE, { month: 'short' });
      const cls = ['yr-cell', key === month ? 'is-selected' : '', key === thisMonth ? 'is-today' : '', t ? 'has-entries' : ''].join(' ');
      const label = `${name} ${year}${t?.out ? `, spent ${money.format(t.out)}` : ''}${t?.in ? `, received ${money.format(t.in)}` : ''}${t ? `, ${t.n} ${t.n === 1 ? 'entry' : 'entries'}` : ''}`;
      return `
        <button type="button" class="${cls}" data-year-month="${key}" aria-label="${label}" title="${label}" aria-pressed="${key === month}">
          <span class="yr-name">${name}</span>
          ${t?.out ? `<span class="yr-out">−${moneyWhole.format(t.out)}</span>` : ''}
          ${t?.in ? `<span class="yr-in">+${moneyWhole.format(t.in)}</span>` : ''}
          ${t ? `<span class="yr-count">${t.n} ${t.n === 1 ? 'entry' : 'entries'}</span>` : ''}
        </button>`;
    }).join('');
    return `
      <div class="card cal-card">
        <div class="yr-grid">${cells}</div>
        <div class="cal-total muted small">
          ${year}: <span class="amount-out">− ${money.format(yearOut)}</span> · <span class="amount-in">+ ${money.format(yearIn)}</span>
        </div>
      </div>`;
  }

  function calendarGridHtml(month, monthEntriesList, day) {
    const [y, m] = month.split('-').map(Number);
    const daysInMonth = new Date(y, m, 0).getDate();
    const lead = (new Date(y, m - 1, 1).getDay() + 6) % 7;
    const totals = new Map();
    let monthOut = 0;
    let monthIn = 0;
    for (const e of monthEntriesList) {
      const t = totals.get(e.spent_on) || { out: 0, in: 0 };
      if (e.direction === 'credit') {
        t.in += e.amount;
        monthIn += e.amount;
      } else {
        t.out += e.amount;
        monthOut += e.amount;
      }
      totals.set(e.spent_on, t);
    }
    const today = todayISO();
    const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => `<span class="cal-wd">${d}</span>`).join('');
    const blanks = '<span class="cal-cell is-blank"></span>'.repeat(lead);
    const cells = Array.from({ length: daysInMonth }, (_, i) => {
      const key = `${month}-${pad2(i + 1)}`;
      const t = totals.get(key);
      const cls = ['cal-cell', key === day ? 'is-selected' : '', key === today ? 'is-today' : '', t ? 'has-entries' : ''].join(' ');
      const label = `${formatDay(key)}${t?.out ? `, spent ${money.format(t.out)}` : ''}${t?.in ? `, received ${money.format(t.in)}` : ''}`;
      return `
        <button type="button" class="${cls}" data-cal-day="${key}" aria-label="${label}" aria-pressed="${key === day}">
          <span class="cal-num">${i + 1}</span>
          ${t?.out ? `<span class="cal-out">−${compactNumber.format(t.out)}</span>` : ''}
          ${t?.in ? `<span class="cal-in">+${compactNumber.format(t.in)}</span>` : ''}
        </button>`;
    }).join('');
    return `
      <div class="card cal-card">
        <div class="cal-grid">${weekdays}${blanks}${cells}</div>
        <div class="cal-total muted small">
          Month: <span class="amount-out">− ${money.format(monthOut)}</span> · <span class="amount-in">+ ${money.format(monthIn)}</span>
        </div>
      </div>`;
  }

  /** One entry row: ☐ | Amount / date / time | Purpose (2 lines) | Pay via / 📝 Paid by.
      Tapping the row (or its purpose) opens the full details; 📝 shows the note in a tooltip. */
  function entryRowHtml(e) {
    const note = entryNote(e);
    const checked = selectedEntryIds.has(e.id);
    return `
      <li class="entry-row ${checked ? 'is-selected' : ''}" data-action="entry-details" data-id="${e.id}">
        <label class="row-check" aria-label="Select entry"><input type="checkbox" data-id="${e.id}" data-day="${e.spent_on}" ${checked ? 'checked' : ''} /></label>
        <span class="er-col er-left">
          <span class="er-amount ${amountClass(e)}">${signed(e)}</span>
          <span class="er-date">${formatDay(e.spent_on)}</span>
          <span class="er-date">${formatTime(entryTime(e))}</span>
        </span>
        <span class="er-col er-mid">
          <button type="button" class="er-purpose" data-action="entry-details" data-id="${e.id}"><span class="clamp-3"><span class="er-cat" aria-hidden="true">${categoryOf(e.category).icon}</span> ${escapeHtml(entryPurpose(e))}</span></button>
        </span>
        <span class="er-col er-right">
          <span class="er-via">${escapeHtml(e.pay_via || '—')}</span>
          <span class="er-by">
            ${note ? `<button type="button" class="note-btn" data-action="show-note" data-id="${e.id}" aria-label="Show note" title="Show note">📝</button>` : ''}
            ${spendTypeOf(e) ? `<span class="spend-tag stype-${spendTypeOf(e).id}">${spendTypeOf(e).label}</span>` : ''}
            ${paidByMe(e) ? '' : `<span class="paid-by">${escapeHtml(entryPaidBy(e))}</span>`}
          </span>
        </span>
      </li>`;
  }

  // ---------- entry details sheet & note tooltip ----------

  let sheetEntryId = null;

  function openEntrySheet(id) {
    const e = entries.find((x) => x.id === id);
    if (!e) return;
    hideNoteTip();
    sheetEntryId = id;
    const list = findList(e.list_id);
    const cat = categoryOf(e.category);
    const credit = e.direction === 'credit';
    const shared = list && (roleFor(list) !== 'owner' || listMembers(list.id).length > 0);

    $('es-amount').textContent = signed(e);
    $('es-amount').className = `es-amount ${amountClass(e)}`;
    $('es-purpose').textContent = entryPurpose(e);
    const details = [
      ['📅', 'Date & time', formatWhen(e.spent_on, entryTime(e))],
      [cat.icon, 'Category', cat.label],
      ['💳', credit ? 'Received via' : 'Pay via', e.pay_via || '—'],
      ...(credit ? [] : [[spendTypeOf(e)?.icon || '🏷️', 'Expense type', spendTypeOf(e)?.label || '—']]),
      ['👤', credit ? 'Received by' : 'Paid by', entryPaidBy(e)],
      ['📝', 'Note', entryNote(e) || '—'],
    ];
    if (shared) details.push(['✍️', 'Added by', isMine(e) ? 'You' : e.author_name || 'a friend']);
    $('es-details').innerHTML = details
      .map(([icon, label, value]) => `<div class="detail-row"><dt><span aria-hidden="true">${icon}</span> ${label}</dt><dd>${escapeHtml(value)}</dd></div>`)
      .join('');

    // You can change only entries you added (and only while you may still add entries).
    const editable = isMine(e) && list && canAddEntries(list);
    $('es-actions').innerHTML = editable
      ? `<button class="btn btn-ghost grow danger-text" type="button" data-es="delete">🗑️ Delete</button>
         <button class="btn btn-gradient grow" type="button" data-es="edit">✏️ Edit</button>`
      : '<button class="btn btn-gradient grow" type="button" data-es="close">Close</button>';
    openSheet($('entry-sheet'));
  }

  async function onEntrySheetAction(event) {
    const btn = event.target.closest('[data-es]');
    if (!btn) return;
    const e = entries.find((x) => x.id === sheetEntryId);
    closeSheet($('entry-sheet'));
    if (!e) return;
    if (btn.dataset.es === 'edit') openEntryFormSheet(findList(e.list_id), e);
    else if (btn.dataset.es === 'delete') await confirmDeleteEntry(e);
  }

  async function confirmDeleteEntry(e) {
    const cat = categoryOf(e.category);
    const ok = await askSheet({
      subject: { icon: cat.icon, name: entryPurpose(e), meta: `${signed(e)} · ${formatWhen(e.spent_on, entryTime(e))}` },
      title: 'Are you sure you want to delete this entry?',
      confirmText: 'Delete',
      danger: true,
    });
    if (!ok) return;
    await updateRow('expenses', e.id, { deleted: true });
    toast('Entry deleted');
  }

  function showNoteTip(btn) {
    const e = entries.find((x) => x.id === btn.dataset.id);
    if (e) showTip(btn, e.id, entryNote(e));
  }

  /** The tooltip under (or above) `btn` with `text`; tapping the same button again closes it. */
  function showTip(btn, forId, text) {
    const tip = $('note-tip');
    if (!tip.hidden && tip.dataset.for === forId) return hideNoteTip();
    tip.textContent = text;
    tip.dataset.for = forId;
    tip.hidden = false;
    const r = btn.getBoundingClientRect();
    const left = Math.min(Math.max(8, r.left + r.width / 2 - tip.offsetWidth / 2), innerWidth - tip.offsetWidth - 8);
    const below = r.bottom + 8 + tip.offsetHeight <= innerHeight;
    tip.style.left = `${left}px`;
    tip.style.top = `${below ? r.bottom + 8 : r.top - tip.offsetHeight - 8}px`;
  }

  function hideNoteTip() {
    $('note-tip').hidden = true;
  }

  // ---------- actions on cards and rows ----------

  async function onAction(event) {
    // Row checkboxes and sort headers have their own handlers (and must keep their default behaviour).
    if (event.target.closest('.row-check')) return;
    const chartPick = event.target.closest('[data-chart-view], [data-chart-shape], [data-chart-period]');
    if (chartPick) {
      const d = chartPick.dataset;
      return setChart(d.chartView ? { view: d.chartView } : d.chartPeriod ? { period: d.chartPeriod } : { shape: d.chartShape });
    }
    const budgetShape = event.target.closest('[data-budget-shape]');
    if (budgetShape) return setChart({ budgetShape: budgetShape.dataset.budgetShape });
    // The budget plan card is read-only: tapping its rows or chart does nothing.
    const chartTip = event.target.closest('.chart-card:not(.budget-card) [data-tip]');
    if (chartTip) {
      document.querySelectorAll('.chart-card .is-tipped').forEach((el) => el.classList.remove('is-tipped'));
      chartTip.classList.add('is-tipped');
      // A slice / column and its legend row light up together; the row already shows the numbers.
      const slice = chartTip.dataset.slice;
      if (slice != null) {
        const linked = document.querySelectorAll(`.chart-card [data-slice="${slice}"]`);
        linked.forEach((el) => el.classList.add('is-tipped'));
        [...linked].find((el) => el.matches('.cl-row'))?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
      if ($('chart-tip')) $('chart-tip').textContent = chartTip.dataset.tip;
      return;
    }
    const yearMonth = event.target.closest('[data-year-month]');
    if (yearMonth) return showMonth(yearMonth.dataset.yearMonth);
    const calDay = event.target.closest('[data-cal-day]');
    if (calDay) {
      selectedDayByList.set(currentListId, calDay.dataset.calDay);
      selectedEntryIds.clear();
      return renderListDetail();
    }
    if (event.target.closest('[data-sort-reset]')) return resetSort();
    if (event.target.closest('[data-days-only]')) return toggleDaysOnly();
    const sortBtn = event.target.closest('[data-sort]');
    if (sortBtn) return toggleSort(sortBtn.dataset.sort);
    const btn = event.target.closest('[data-action]');
    if (!btn) return;
    event.preventDefault();
    const { action, id } = btn.dataset;

    const target = lists.find((l) => l.id === id);
    if (['fav-list', 'edit-list', 'delete-list'].includes(action) && target && isDefaultList(target)) return; // fixed default list

    if (action === 'fav-list') {
      const list = target;
      await updateRow('lists', id, { favorite: !list.favorite });
      toast(list.favorite ? 'Removed from quick access' : '❤️ Added to quick access');
    } else if (action === 'share-list') {
      openShareDialog(id);
    } else if (action === 'edit-list') {
      location.hash = `#/lists/edit/${id}`;
    } else if (action === 'delete-list') {
      const list = lists.find((l) => l.id === id);
      const n = stats.get(id).count;
      const people = listMembers(id).length;
      const k = kindOf(list.kind);
      const ok = await askSheet({
        subject: { icon: k.icon, name: list.name, meta: `${k.label} · ${n ? `${n} ${n === 1 ? 'entry' : 'entries'}` : 'no entries'}` },
        title: 'Are you sure you want to delete this list?',
        // Warning box only when something else is affected.
        message: [
          n ? `Its ${n} ${n === 1 ? 'entry' : 'entries'} will be deleted too.` : '',
          people ? `The ${people} ${people === 1 ? 'person' : 'people'} you shared it with will lose access.` : '',
        ]
          .filter(Boolean)
          .map((s, i) => (i === 0 ? `⚠️ ${s}` : s))
          .join(' '),
        confirmText: 'Delete',
        danger: true,
      });
      if (!ok) return;
      await deleteList(id);
      toast('List deleted');
    } else if (action === 'entry-details') {
      openEntrySheet(id);
    } else if (action === 'toggle-note') {
      if (openNoteIds.has(id)) openNoteIds.delete(id);
      else openNoteIds.add(id);
      renderListDetail();
    } else if (action === 'edit-note') {
      const n = notes.find((x) => x.id === id);
      if (n) openEntryFormSheet(findList(n.list_id), n);
    } else if (action === 'delete-note') {
      const n = notes.find((x) => x.id === id);
      if (!n) return;
      const t = noteTypeOf(n.category);
      const ok = await askSheet({
        subject: { icon: t.icon, name: n.purpose || t.label, meta: `${t.label} · ${formatWhen(n.spent_on, entryTime(n))}` },
        title: 'Are you sure you want to delete this note?',
        confirmText: 'Delete',
        danger: true,
      });
      if (!ok) return;
      openNoteIds.delete(id);
      await updateRow('expenses', id, { deleted: true });
      toast('Note deleted');
    } else if (action === 'budget-info') {
      showTip(btn, 'budget-info', BUDGET_INFO);
    } else if (action === 'show-note') {
      showNoteTip(btn);
    }
  }

  // ---------- entry form ----------

  /** Chip label: "Liquor & Smoke" → "Liquor" with a smaller "& Smoke" line underneath. */
  function chipLabel(label) {
    const [main, rest] = label.split(' & ');
    return rest ? `<span class="chip-name">${main}</span><span class="chip-sub">&amp; ${rest}</span>` : `<span class="chip-name">${label}</span>`;
  }

  function renderCategories() {
    $('categories').innerHTML = CATEGORIES.map(
      (c) => `
        <button type="button" role="radio" data-category="${c.id}" aria-label="${c.label}"
          aria-checked="${c.id === selectedCategory}"
          class="chip ${c.id === selectedCategory ? 'chip-active' : ''}">
          <span class="chip-icon" aria-hidden="true">${c.icon}</span>${chipLabel(c.label)}
        </button>`,
    ).join('');
    $('purpose-icon').textContent = categoryOf(selectedCategory).icon; // purpose field shows the category icon
  }

  function renderDirection() {
    const credit = entryDirection === 'credit';
    const btn = $('dir-toggle');
    $('dir-sign').textContent = credit ? '+' : '−';
    btn.classList.toggle('is-credit', credit);
    btn.setAttribute('aria-label', credit ? 'Received. Tap to switch to spent' : 'Spent. Tap to switch to received');
    btn.title = credit ? 'Received (tap for spent)' : 'Spent (tap for received)';
    $('amount-row').classList.toggle('is-credit', credit);
    $('pay-via-label').textContent = credit ? 'Received via' : 'Pay via';
    $('paid-by-label').textContent = credit ? 'Received by' : 'Paid by';
    $('spend-type-field').hidden = credit; // Need / Want / Saving is for money spent
  }

  let selectedSpendType = '';
  function renderSpendType() {
    $('spend-type').innerHTML = SPEND_TYPES.map(
      (t) => `<button type="button" role="radio" data-spend-type="${t.id}" aria-checked="${t.id === selectedSpendType}"
        class="pill stype-${t.id} ${t.id === selectedSpendType ? 'is-on' : ''}">${t.icon} ${t.label}</button>`,
    ).join('');
  }

  // ---------- pay via / paid by options (editable, saved on this device) ----------

  const OPTIONS = {
    pay: {
      key: 'myExpenses.payMethods',
      defaults: () => PAY_VIA,
      title: 'Payment methods',
      hint: 'Add, rename or remove the ways you pay, e.g. "PhonePe UPI" or "HDFC Card".',
      placeholder: 'e.g. PhonePe UPI',
    },
    people: {
      key: 'myExpenses.people',
      defaults: () => [firstName()],
      title: 'Paid by',
      hint: 'Add, rename or remove the people who pay or receive money.',
      placeholder: 'e.g. Moupeya',
    },
  };

  function getOptions(kind) {
    const saved = storage((s) => JSON.parse(s.getItem(OPTIONS[kind].key) || 'null'));
    return Array.isArray(saved) ? saved : OPTIONS[kind].defaults();
  }
  const setOptions = (kind, values) => storage((s) => s.setItem(OPTIONS[kind].key, JSON.stringify(values)));

  const PAY_VIA_KEY = 'myExpenses.lastPayVia';
  let selectedPayVia = 'UPI';
  let selectedPaidBy = '';
  const lastPayVia = () => {
    const last = storage((s) => s.getItem(PAY_VIA_KEY));
    const options = getOptions('pay');
    return options.includes(last) ? last : options[0] || '';
  };

  /** Pills for one option kind; a value saved on an entry but since removed from the list still shows. */
  function pillsHtml(kind, selected, attr) {
    const values = getOptions(kind);
    if (selected && !values.includes(selected)) values.push(selected);
    // "＋ Add" sits at the end of the row and opens the add / rename / remove sheet.
    const label = kind === 'pay' ? 'Add or edit payment methods' : 'Add or edit names';
    return values
      .map(
        (v) => `<button type="button" role="radio" ${attr}="${escapeHtml(v)}" aria-checked="${v === selected}"
          class="pill ${v === selected ? 'is-on' : ''}">${escapeHtml(v)}</button>`,
      )
      .join('') + `<button type="button" class="pill pill-add" data-manage="${kind}" aria-label="${label}" title="${label}">＋ Add</button>`;
  }
  const renderPayVia = () => ($('pay-via').innerHTML = pillsHtml('pay', selectedPayVia, 'data-pay-via'));
  const renderPaidBy = () => ($('paid-by').innerHTML = pillsHtml('people', selectedPaidBy, 'data-paid-by'));

  let managingKind = null;

  function openOptionsSheet(kind) {
    managingKind = kind;
    const o = OPTIONS[kind];
    $('opt-title').textContent = o.title;
    $('opt-hint').textContent = o.hint;
    $('opt-input').placeholder = o.placeholder;
    $('opt-input').value = '';
    setError('opt-error', '');
    renderOptionsList();
    openSheet($('options-sheet'));
  }

  function renderOptionsList() {
    const values = getOptions(managingKind);
    $('opt-list').innerHTML = values.length
      ? values
          .map(
            (v, i) => `
          <li class="member">
            <input class="opt-name" type="text" maxlength="40" value="${escapeHtml(v)}" data-opt-index="${i}" aria-label="Rename ${escapeHtml(v)}" />
            <button class="icon-btn" type="button" data-opt-delete="${i}" aria-label="Delete ${escapeHtml(v)}">✕</button>
          </li>`,
          )
          .join('')
      : '<li class="muted small member-empty">Nothing here yet.</li>';
  }

  const isDuplicate = (values, name, skip = -1) => values.some((v, i) => i !== skip && v.toLowerCase() === name.toLowerCase());

  function onOptionAdd(event) {
    event.preventDefault();
    const name = $('opt-input').value.trim();
    const values = getOptions(managingKind);
    if (!name) return setError('opt-error', 'Type a name to add');
    if (isDuplicate(values, name)) return setError('opt-error', `"${name}" is already in the list`);
    setError('opt-error', '');
    setOptions(managingKind, [...values, name]);
    if (managingKind === 'pay') selectedPayVia = name;
    else selectedPaidBy = name;
    $('opt-input').value = '';
    renderOptionsList();
    renderPayVia();
    renderPaidBy();
  }

  function onOptionRename(event) {
    const input = event.target.closest('[data-opt-index]');
    if (!input) return;
    const i = Number(input.dataset.optIndex);
    const values = getOptions(managingKind);
    const old = values[i];
    const name = input.value.trim();
    if (!name || isDuplicate(values, name, i)) {
      input.value = old; // empty or duplicate: keep the old name
      return setError('opt-error', name ? `"${name}" is already in the list` : '');
    }
    setError('opt-error', '');
    values[i] = name;
    setOptions(managingKind, values);
    if (managingKind === 'pay' && old.toLowerCase() === cashMethod().toLowerCase()) storage((s) => s.setItem(CASH_KEY, name));
    if (selectedPayVia === old && managingKind === 'pay') selectedPayVia = name;
    if (selectedPaidBy === old && managingKind === 'people') selectedPaidBy = name;
    renderPayVia();
    renderPaidBy();
    renameInEntries(managingKind === 'pay' ? 'pay_via' : 'paid_by', old, name);
  }

  /** A renamed pay method / person: every entry of yours that used the old name gets the new one. */
  async function renameInEntries(field, old, name) {
    const now = nowISO();
    const rows = (await DB.all('expenses')).filter((r) => !r.deleted && (r[field] || '').toLowerCase() === old.toLowerCase() && canDeleteEntry(r));
    if (!rows.length) return;
    await DB.putMany('expenses', rows.map((r) => ({ ...r, [field]: name, updated_at: now, synced: 0 })));
    await afterWrite();
    toast(`Renamed in ${rows.length} ${rows.length === 1 ? 'entry' : 'entries'}`);
  }

  function onOptionDelete(event) {
    const btn = event.target.closest('[data-opt-delete]');
    if (!btn) return;
    const values = getOptions(managingKind);
    const [removed] = values.splice(Number(btn.dataset.optDelete), 1);
    setOptions(managingKind, values);
    if (managingKind === 'pay' && selectedPayVia === removed) selectedPayVia = values[0] || '';
    if (managingKind === 'people' && selectedPaidBy === removed) selectedPaidBy = values[0] || '';
    renderOptionsList();
    renderPayVia();
    renderPaidBy();
  }

  function setError(id, msg) {
    $(id).hidden = !msg;
    $(id).textContent = msg || '';
  }

  /** "+ Add entry" / ✏️ Edit: the entry (or note) form in a bottom sheet over the list. */
  function openEntryFormSheet(list, entry) {
    if (!list || !canAddEntries(list) || (entry && !isMine(entry))) return;
    const isNote = entry?.kind === 'note';
    openEntryForm(list, isNote ? null : entry);
    openNoteForm(isNote ? entry : null);
    $('ef-tabs').hidden = Boolean(entry); // editing keeps its kind
    $('ef-list').textContent = `${kindOf(list.kind).icon} ${list.name}`;
    setEntryFormTab(isNote ? 'note' : 'entry', Boolean(entry));
    $('entry-form-sheet').scrollTop = 0;
    openSheet($('entry-form-sheet'));
    if (!entry) (entryFormTab === 'note' ? $('n-text') : $('amount')).focus();
  }

  function setEntryFormTab(tab, editing = false) {
    entryFormTab = tab;
    for (const t of ['entry', 'note']) {
      $(`ef-tab-${t}`).classList.toggle('is-on', t === tab);
      $(`ef-tab-${t}`).setAttribute('aria-selected', t === tab);
    }
    $('entry-form').hidden = tab !== 'entry';
    $('note-form').hidden = tab !== 'note';
    $('ef-title').textContent = `${editing ? 'Edit' : 'New'} ${tab === 'note' ? 'note' : 'entry'}`;
  }

  function renderNoteTypes() {
    $('n-types').innerHTML = NOTE_TYPES.map(
      (t) => `
        <button type="button" role="radio" class="note-type-chip note-${t.id} ${t.id === selectedNoteType ? 'is-on' : ''}"
          data-note-type="${t.id}" aria-checked="${t.id === selectedNoteType}">
          <span aria-hidden="true">${t.icon}</span><span>${t.label}</span>
        </button>`,
    ).join('');
  }

  function openNoteForm(note) {
    editingNoteId = note ? note.id : null;
    selectedNoteType = note ? noteTypeOf(note.category).id : selectedNoteType;
    $('n-date').value = note ? note.spent_on : todayISO();
    $('n-time').value = note ? entryTime(note) : nowTime();
    $('n-text').value = note ? note.note : '';
    $('note-submit').textContent = note ? 'Update note' : 'Save note';
    renderNoteTypes();
    setError('note-error', '');
  }

  async function onNoteSubmit(event) {
    event.preventDefault();
    const text = $('n-text').value.replace(/\s+$/, '');
    if (!text.trim()) return setError('note-error', 'Write the note');
    if (!$('n-date').value) return setError('note-error', 'Pick a date');
    const type = noteTypeOf(selectedNoteType);
    const input = {
      kind: 'note',
      list_id: currentListId,
      direction: 'credit',
      amount: 0, // notes are text only
      category: type.id,
      purpose: text.trim().split('\n')[0].slice(0, 200), // the one-liner (also used by search)
      note: text,
      pay_via: '',
      paid_by: '',
      spent_on: $('n-date').value,
      spent_time: $('n-time').value || nowTime(),
    };
    $('note-submit').disabled = true;
    try {
      if (editingNoteId) {
        await updateRow('expenses', editingNoteId, input);
        toast(`${type.icon} Note updated`);
      } else {
        await addEntry(input);
        toast(`${type.icon} Note added`);
      }
      closeSheet($('entry-form-sheet'));
    } catch (e) {
      setError('note-error', e?.message || String(e));
    } finally {
      $('note-submit').disabled = false;
    }
  }

  function openEntryForm(list, entry) {
    editingEntryId = entry ? entry.id : null;
    currentListId = list.id;
    entryDirection = entry ? entry.direction || 'debit' : 'debit';
    // New entries start as "Spent", so don't carry over an income-only category from the last one.
    selectedCategory = entry
      ? entry.category
      : RECEIVE_CATEGORIES.includes(selectedCategory) || !CATEGORIES.some((c) => c.id === selectedCategory)
        ? DEFAULT_SPEND_CATEGORY
        : selectedCategory;
    selectedPayVia = (entry && entry.pay_via) || lastPayVia();
    $('amount').value = entry ? entry.amount : '';
    $('purpose').value = entry ? entry.purpose || entry.note : '';
    $('note').value = entry ? entryNote(entry) : '';
    $('date').value = entry ? entry.spent_on : todayISO();
    $('time').value = entry ? entryTime(entry) : nowTime();
    // Default "paid by": the first saved name (your name, or "Me" when signed out).
    const paidBy = entry ? entryPaidBy(entry) : getOptions('people')[0] || firstName();
    selectedPaidBy = paidBy === '—' ? '' : paidBy;
    selectedSpendType = (entry && entry.spend_type) || '';
    $('entry-submit').textContent = entry ? 'Update entry' : 'Save entry';
    renderDirection();
    renderCategories();
    renderSpendType();
    renderPayVia();
    renderPaidBy();
    setError('entry-error', '');
  }

  async function onEntrySubmit(event) {
    event.preventDefault();
    const amount = Number($('amount').value);
    if (!Number.isFinite(amount) || amount <= 0) return setError('entry-error', 'Enter an amount greater than 0');
    const purpose = $('purpose').value.trim();
    if (!purpose) return setError('entry-error', 'Enter the purpose');
    if (!$('date').value) return setError('entry-error', 'Pick a date');

    const input = {
      list_id: currentListId,
      direction: entryDirection,
      amount: Math.round(amount * 100) / 100,
      category: selectedCategory,
      purpose,
      note: $('note').value.trim(),
      pay_via: selectedPayVia,
      paid_by: selectedPaidBy || firstName(),
      spend_type: entryDirection === 'credit' ? '' : selectedSpendType,
      spent_on: $('date').value,
      spent_time: $('time').value || nowTime(),
    };
    storage((s) => s.setItem(PAY_VIA_KEY, selectedPayVia));
    $('entry-submit').disabled = true;
    try {
      if (editingEntryId) {
        await updateRow('expenses', editingEntryId, input);
        toast('Entry updated');
      } else {
        await addEntry(input);
        toast(`${input.direction === 'credit' ? '+' : '−'} ${money.format(input.amount)} added`);
      }
      closeSheet($('entry-form-sheet'));
    } catch (e) {
      setError('entry-error', e?.message || String(e));
    } finally {
      $('entry-submit').disabled = false;
    }
  }

  // ---------- list form ----------

  function renderKinds() {
    $('kinds').innerHTML = KINDS.map(
      (k) => `
        <button type="button" role="radio" data-kind="${k.id}" aria-checked="${k.id === selectedKind}"
          class="kind-chip ${k.id === selectedKind ? 'chip-active' : ''}">
          <span aria-hidden="true">${k.icon}</span><span>${k.label}</span>
        </button>`,
    ).join('');
  }

  function openListForm(list) {
    editingListId = list ? list.id : null;
    selectedKind = list ? kindOf(list.kind).id : KINDS[0].id;
    $('list-name').value = list ? list.name : '';
    $('list-submit').textContent = list ? 'Save changes' : 'Create list';
    renderKinds();
    setError('list-error', '');
    if (!list) $('list-name').focus();
  }

  async function onListSubmit(event) {
    event.preventDefault();
    const name = $('list-name').value.trim();
    if (!name) return setError('list-error', 'Give your list a name');
    $('list-submit').disabled = true;
    try {
      if (editingListId) {
        await updateRow('lists', editingListId, { name, kind: selectedKind });
        toast('List updated');
        location.hash = '#/lists';
      } else {
        const list = await addList({ name, kind: selectedKind });
        toast(`"${name}" created`);
        location.hash = `#/list/${list.id}`;
      }
    } catch (e) {
      setError('list-error', e?.message || String(e));
    } finally {
      $('list-submit').disabled = false;
    }
  }

  // ---------- routing ----------

  function route() {
    const [page = '', a, b, c] = location.hash.replace(/^#\/?/, '').split('/');
    const ownList = (id) => lists.find((l) => l.id === id);
    let next = 'home';

    if (page === 'lists' && a === 'new') {
      next = 'list-form';
      openListForm(null);
      setHeader({ compact: true, title: '➕ New expense list', back: '#/lists' });
    } else if (page === 'lists' && a === 'edit' && ownList(b) && !isDefaultList(ownList(b))) {
      next = 'list-form';
      openListForm(ownList(b));
      setHeader({ compact: true, title: '✏️ Edit list', back: '#/lists' });
    } else if (page === 'lists') {
      next = 'lists';
      setHeader({ compact: true, title: '📋 Your Expenses', back: '#/' });
    } else if (page === 'list' && findList(a)) {
      const list = findList(a);
      // Opening a list (from a card, not re-routing within it): start fresh with no filters, month view, this month.
      if (view !== 'list' || currentListId !== list.id) {
        selectedEntryIds.clear();
        filters = emptyFilters();
        selectedMonthByList.delete(list.id);
        if (viewMode !== 'month') {
          viewMode = 'month';
          storage((s) => s.setItem(VIEW_KEY, viewMode));
        }
      }
      currentListId = list.id;
      const title = `${kindOf(list.kind).icon} ${list.name}`;
      const entry = entries.find((e) => e.id === c && e.list_id === list.id);
      // Old /new and /edit links: show the list and open the entry form sheet on top of it.
      let sheetEntry;
      if (b === 'new' && canAddEntries(list)) sheetEntry = null;
      else if (b === 'edit' && entry && isMine(entry) && canAddEntries(list)) sheetEntry = entry;
      if (b) history.replaceState(null, '', `#/list/${list.id}`);
      next = 'list';
      renderListDetail();
      setHeader({ compact: true, title, back: isMine(list) ? '#/lists' : '#/shared' });
      if (sheetEntry !== undefined) setTimeout(() => openEntryFormSheet(list, sheetEntry), 0);
    } else if (page === 'shared') {
      next = 'shared';
      setHeader({ compact: true, title: '👥 Shared with you', back: '#/' });
    } else if (page === 'list' || page === 'lists') {
      location.replace('#/lists'); // list was deleted or doesn't exist
      return;
    } else {
      setHeader({ compact: false });
    }

    view = next;
    for (const v of ['home', 'lists', 'list', 'shared', 'list-form']) $(`view-${v}`).hidden = v !== view;
    // List page: toolbar and table header stay fixed, only the rows scroll.
    document.body.classList.toggle('list-mode', view === 'list');
    window.scrollTo(0, 0);
  }

  function renderData() {
    renderHome();
    renderLists();
    renderShared();
    if (view === 'list') renderListDetail();
    if ($('share-dialog').open) renderShareDialog();
    renderStatus();
  }

  async function onCloudEvent(type) {
    if (type === 'auth') {
      const uid = currentUserId();
      if (uid) {
        await claimGuestRows(uid);
        Cloud.syncNow();
      }
      renderAccount();
    }
    await load(); // 'auth', 'sync' or 'data'
  }

  // ---------- start ----------

  async function start() {
    renderThemeButton();
    $('currency-symbol').textContent = money.formatToParts(0).find((p) => p.type === 'currency')?.value || '';
    $('date').max = todayISO();

    $('theme-btn').addEventListener('click', toggleTheme);
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', renderThemeButton);
    $('signin-btn').addEventListener('click', onSignInClick);
    $('logout-btn').addEventListener('click', onLogoutClick);
    $('profile-btn').addEventListener('click', openProfileSheet);
    $('profile-logout').addEventListener('click', onProfileLogout);
    $('install-btn').addEventListener('click', onInstallClick);
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault(); // show our own "Install app" button instead of the browser's mini-bar
      installPrompt = e;
      renderInstall();
    });
    window.addEventListener('appinstalled', () => {
      installPrompt = null;
      installed = true;
      renderInstall();
      toast('🎉 App installed');
    });

    document.querySelector('main').addEventListener('click', onAction);
    $('categories').addEventListener('click', (e) => {
      const chip = e.target.closest('[data-category]');
      if (!chip) return;
      selectedCategory = chip.dataset.category;
      renderCategories();
    });
    // The −/+ button toggles spent ↔ received. Switching to "+" picks the Received category;
    // switching back restores the previous one.
    let categoryBeforeCredit = null;
    $('dir-toggle').addEventListener('click', () => {
      entryDirection = entryDirection === 'debit' ? 'credit' : 'debit';
      if (entryDirection === 'credit' && !RECEIVE_CATEGORIES.includes(selectedCategory)) {
        categoryBeforeCredit = selectedCategory;
        selectedCategory = DEFAULT_RECEIVE_CATEGORY;
      } else if (entryDirection === 'debit' && categoryBeforeCredit && RECEIVE_CATEGORIES.includes(selectedCategory)) {
        selectedCategory = categoryBeforeCredit;
      }
      if (entryDirection === 'debit') categoryBeforeCredit = null;
      renderCategories();
      renderDirection();
    });
    $('kinds').addEventListener('click', (e) => {
      const chip = e.target.closest('[data-kind]');
      if (!chip) return;
      selectedKind = chip.dataset.kind;
      renderKinds();
    });
    $('share-form').addEventListener('submit', onShareSubmit);
    $('share-members').addEventListener('click', onShareMembersClick);
    $('share-members').addEventListener('change', onShareRoleChange);
    $('share-copy').addEventListener('click', copyListLink);
    $('share-signin').addEventListener('click', () => {
      closeSheet($('share-dialog'));
      onSignInClick();
    });
    document.querySelectorAll('dialog.sheet').forEach(wireSheet);
    $('entry-form').addEventListener('submit', onEntrySubmit);
    $('note-form').addEventListener('submit', onNoteSubmit);
    $('ef-tabs').addEventListener('click', (e) => {
      const tab = e.target.closest('[data-ef-tab]');
      if (!tab) return;
      setEntryFormTab(tab.dataset.efTab);
      (entryFormTab === 'note' ? $('n-text') : $('amount')).focus();
    });
    $('n-types').addEventListener('click', (e) => {
      const chip = e.target.closest('[data-note-type]');
      if (!chip) return;
      selectedNoteType = chip.dataset.noteType;
      renderNoteTypes();
    });
    $('list-form').addEventListener('submit', onListSubmit);
    for (const id of ['pay-via', 'paid-by']) {
      $(id).addEventListener('click', (e) => {
        const add = e.target.closest('[data-manage]');
        if (add) openOptionsSheet(add.dataset.manage);
      });
    }
    $('pay-via').addEventListener('click', (e) => {
      const pill = e.target.closest('[data-pay-via]');
      if (!pill) return;
      selectedPayVia = pill.dataset.payVia;
      renderPayVia();
    });
    $('paid-by').addEventListener('click', (e) => {
      const pill = e.target.closest('[data-paid-by]');
      if (!pill) return;
      selectedPaidBy = pill.dataset.paidBy;
      renderPaidBy();
    });
    $('spend-type').addEventListener('click', (e) => {
      const pill = e.target.closest('[data-spend-type]');
      if (!pill) return;
      // Tap the chosen type again to clear it.
      selectedSpendType = selectedSpendType === pill.dataset.spendType ? '' : pill.dataset.spendType;
      renderSpendType();
    });
    $('opt-add').addEventListener('submit', onOptionAdd);
    $('opt-list').addEventListener('change', onOptionRename);
    $('opt-list').addEventListener('click', onOptionDelete);
    $('es-actions').addEventListener('click', onEntrySheetAction);
    // List toolbar: month picker works now; the other buttons are placeholders for upcoming features.
    // ◀ ▶ step a month (a whole year in year view).
    $('month-prev').addEventListener('click', () => showMonth(addMonths(shownMonth(), viewMode === 'year' || chartByYear() ? -12 : -1)));
    $('month-next').addEventListener('click', () => showMonth(addMonths(shownMonth(), viewMode === 'year' || chartByYear() ? 12 : 1)));
    $('month-btn').addEventListener('click', openMonthSheet);
    $('filter-btn').addEventListener('click', openFilterSheet);
    $('view-mode-btn').addEventListener('click', openViewSheet);
    $('export-btn').addEventListener('click', () => openExportSheet());
    $('add-entry-btn').addEventListener('click', (e) => {
      e.preventDefault();
      openEntryFormSheet(findList(currentListId), null);
    });
    for (const t of document.querySelectorAll('[data-io-tab]')) t.addEventListener('click', () => showIoTab(t.dataset.ioTab));
    $('im-file').addEventListener('change', onImportFile);
    $('im-text-go').addEventListener('click', onImportPaste);
    // Pasting reads the text straight away (the value is updated after the paste event).
    $('im-text').addEventListener('paste', () => setTimeout(onImportPaste, 0));
    $('im-skip-dupes').addEventListener('change', updateImportSummary);
    $('im-go').addEventListener('click', runImport);
    $('im-sample').addEventListener('click', downloadImportSample);
    $('export-sheet').addEventListener('click', onExportSheetClick);
    $('export-sheet').addEventListener('input', onExportSheetInput);
    $('export-sheet').addEventListener('change', onExportSheetInput);
    $('vm-options').addEventListener('click', (e) => {
      const opt = e.target.closest('[data-view-mode]');
      if (!opt) return;
      setViewMode(opt.dataset.viewMode);
      closeSheet($('view-sheet'));
      toast(VIEW_MODES.find((m) => m.id === viewMode).icon + ' ' + VIEW_MODES.find((m) => m.id === viewMode).label);
    });
    $('filter-clear').addEventListener('click', () => applyFilters(emptyFilters()));
    $('filter-sheet').addEventListener('click', onFilterSheetClick);
    $('f-text').addEventListener('input', () => {
      draftFilters.text = $('f-text').value;
      updateFilterCount();
    });
    $('f-clear').addEventListener('click', () => {
      draftFilters = emptyFilters();
      $('f-text').value = '';
      renderFilterSheet();
    });
    $('f-form').addEventListener('submit', (e) => {
      e.preventDefault(); // Enter in the search box also applies
      applyFilters(copyFilters(draftFilters));
      closeSheet($('filter-sheet'));
      const n = activeFilterCount(filters);
      toast(n ? `🔍 ${n} ${n === 1 ? 'filter' : 'filters'} applied` : 'Showing all entries');
    });
    $('ms-prev-year').addEventListener('click', () => {
      calendarYear -= yearPicking ? YEAR_PAGE : 1;
      renderMonthSheet();
    });
    $('ms-next-year').addEventListener('click', () => {
      calendarYear += yearPicking ? YEAR_PAGE : 1;
      renderMonthSheet();
    });
    $('ms-year').addEventListener('click', () => {
      yearPicking = !yearPicking;
      renderMonthSheet();
    });
    $('ms-grid').addEventListener('click', (e) => {
      const yearBtn = e.target.closest('[data-year]');
      if (yearBtn) {
        calendarYear = Number(yearBtn.dataset.year);
        yearPicking = false;
        renderMonthSheet();
        return;
      }
      const btn = e.target.closest('[data-month]');
      if (!btn) return;
      showMonth(btn.dataset.month);
      closeSheet($('month-sheet'));
    });
    $('ms-today').addEventListener('click', () => {
      showMonth(currentMonth());
      closeSheet($('month-sheet'));
    });
    for (const b of document.querySelectorAll('[data-soon]')) b.addEventListener('click', () => toast(`${b.dataset.soon} · coming soon`));
    $('entries').addEventListener('change', onRowCheck);
    $('entries').addEventListener('scroll', onRowsScroll, true); // long list: load older months
    $('sel-clear').addEventListener('click', clearSelection);
    $('sel-edit').addEventListener('click', openBulkSheet);
    $('sel-delete').addEventListener('click', deleteSelected);
    $('bulk-form').addEventListener('click', onBulkClick);
    $('bulk-form').addEventListener('submit', onBulkSubmit);
    $('bulk-delete').addEventListener('click', () => {
      closeSheet($('bulk-sheet'));
      deleteSelected(); // asks to confirm first
    });
    // Note tooltip closes on any tap elsewhere, on scroll and on navigation.
    document.addEventListener('click', (e) => {
      if (!e.target.closest('[data-action="show-note"], [data-action="budget-info"], #note-tip')) hideNoteTip();
    });
    window.addEventListener('scroll', hideNoteTip, { passive: true });
    window.addEventListener('hashchange', hideNoteTip);
    window.addEventListener('hashchange', route);

    const onNetworkChange = () => {
      renderStatus();
      Cloud.syncNow();
    };
    window.addEventListener('online', onNetworkChange);
    window.addEventListener('offline', onNetworkChange);
    document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && Cloud.syncNow());
    // Pick up friends' changes to shared lists while the app is open.
    setInterval(() => document.visibilityState === 'visible' && Cloud.syncNow(), 60_000);

    try {
      const user = await Cloud.init(onCloudEvent);
      if (user) await claimGuestRows(user.id);
    } catch (e) {
      console.error('Supabase init failed', e);
    }

    renderAccount();
    renderInstall();
    await load();
    route();
    Cloud.syncNow();

    // Installable app + offline support when hosted. Browsers block both on file://.
    if (Cloud.isHosted) {
      const link = Object.assign(document.createElement('link'), { rel: 'manifest', href: 'manifest.json' });
      document.head.appendChild(link);
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service worker not registered', e));
      }
    }
  }

  start();
})();
