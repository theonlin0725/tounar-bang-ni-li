/* IndexedDB durable event queue. One store, ordered by created_at. */
(function () {
  const DB_NAME = 'tounar-queue';
  const STORE = 'events';
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'client_event_id' });
          store.createIndex('by_created', 'created_at');
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return dbPromise;
  }

  async function withStore(mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      const result = fn(store);
      tx.oncomplete = () => resolve(result && result.__value !== undefined ? result.__value : result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  function requestValue(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function add(event) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const getRequest = store.get(event.client_event_id);
      getRequest.onsuccess = () => {
        if (getRequest.result) {
          resolve({ duplicate: true });
          return;
        }
        store.put({ ...event, created_at: event.created_at || new Date().toISOString(), attempts: 0 });
      };
      tx.oncomplete = () => resolve({ duplicate: false });
      tx.onerror = () => reject(tx.error);
    });
  }

  async function list(limit = 50) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const store = tx.objectStore(STORE);
      const index = store.index('by_created');
      const out = [];
      index.openCursor().onsuccess = (event) => {
        const cursor = event.target.result;
        if (!cursor || out.length >= limit) {
          resolve(out);
          return;
        }
        out.push(cursor.value);
        cursor.continue();
      };
      tx.onerror = () => reject(tx.error);
    });
  }

  async function remove(ids) {
    if (!ids.length) return 0;
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      for (const id of ids) store.delete(id);
      tx.oncomplete = () => resolve(ids.length);
      tx.onerror = () => reject(tx.error);
    });
  }

  async function markAttempt(id, error) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const request = store.get(id);
      request.onsuccess = () => {
        const record = request.result;
        if (record) {
          record.attempts = (record.attempts || 0) + 1;
          record.last_error = error || null;
          record.last_attempt_at = new Date().toISOString();
          store.put(record);
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function count() {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const request = tx.objectStore(STORE).count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function clear() {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  globalThis.TounarQueue = { add, list, remove, markAttempt, count, clear };
})();
