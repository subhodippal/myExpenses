// IndexedDB storage. Everything is saved on the device first, so the app works offline
// (including when index.html is opened directly from disk).
//
// Stores (each row has `synced: 0|1`; 0 = still needs uploading to Supabase):
//   lists    { id, user_id, name, kind, favorite, created_at, updated_at, deleted, synced }
//   expenses { id, user_id, list_id, direction: 'debit'|'credit', amount, category, purpose, note,
//              pay_via, paid_by, author_name, spent_on: 'YYYY-MM-DD', spent_time: 'HH:MM',
//              created_at, updated_at, deleted, synced }
//   members  { id, user_id (list owner), list_id, email, role: 'view'|'edit', owner_name,
//              created_at, updated_at, deleted, synced }
// Signed in, the stores hold your own rows plus lists/entries shared with you (owned by others).

const DB = (() => {
  let dbPromise = null;

  function open() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open('my-expenses', 3);
        req.onupgradeneeded = () => {
          const db = req.result;
          for (const name of ['expenses', 'lists', 'members']) {
            if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
          }
          if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }

  const done = (req) =>
    new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

  async function store(name, mode) {
    const db = await open();
    return db.transaction(name, mode).objectStore(name);
  }

  async function putMany(name, rows) {
    if (!rows.length) return;
    const db = await open();
    const tx = db.transaction(name, 'readwrite');
    rows.forEach((r) => tx.objectStore(name).put(r));
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  return {
    all: async (name) => done((await store(name, 'readonly')).getAll()),
    get: async (name, id) => done((await store(name, 'readonly')).get(id)),
    put: async (name, row) => done((await store(name, 'readwrite')).put(row)),
    delete: async (name, id) => done((await store(name, 'readwrite')).delete(id)),
    putMany,
    getMeta: async (key) => (await done((await store('meta', 'readonly')).get(key)))?.value ?? null,
    setMeta: async (key, value) => done((await store('meta', 'readwrite')).put({ key, value })),
    async clearAll() {
      for (const name of ['expenses', 'lists', 'members', 'meta']) await done((await store(name, 'readwrite')).clear());
    },
  };
})();

function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  // Fallback for older browsers: RFC 4122 v4 UUID from random bytes.
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
