// IndexedDB — stockage local des sessions, des points et du trajet GPS.
const DB_NAME = 'find-a-cig';
const DB_VERSION = 2;

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    // Idempotent : gère l'install fraîche comme la migration v1 → v2.
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('sessions')) {
        db.createObjectStore('sessions', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('points')) {
        const points = db.createObjectStore('points', { keyPath: 'id', autoIncrement: true });
        points.createIndex('sessionId', 'sessionId');
        points.createIndex('ts', 'ts');
      }
      if (!db.objectStoreNames.contains('track')) {
        const track = db.createObjectStore('track', { keyPath: 'id', autoIncrement: true });
        track.createIndex('sessionId', 'sessionId');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const result = fn(t.objectStore(store));
    t.oncomplete = () => resolve(result.result !== undefined ? result.result : result);
    t.onerror = () => reject(t.error);
  }));
}

export function createSession(mode = 'detection') {
  return tx('sessions', 'readwrite', s => s.add({ start: Date.now(), end: null, mode }));
}

export async function endSession(id) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction('sessions', 'readwrite');
    const store = t.objectStore('sessions');
    const get = store.get(id);
    get.onsuccess = () => {
      const session = get.result;
      if (session) { session.end = Date.now(); store.put(session); }
    };
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
  });
}

export function addPoint(point) {
  return tx('points', 'readwrite', s => s.add(point));
}

// Complète un point existant (ex. position GPS arrivée après le marquage).
// No-op si le point a été supprimé entre-temps (undo).
export async function updatePoint(id, patch) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction('points', 'readwrite');
    const store = t.objectStore('points');
    const get = store.get(id);
    get.onsuccess = () => {
      if (get.result) store.put({ ...get.result, ...patch });
    };
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
  });
}

export function deletePoint(id) {
  return tx('points', 'readwrite', s => s.delete(id));
}

export async function renameSession(id, name) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction('sessions', 'readwrite');
    const store = t.objectStore('sessions');
    const get = store.get(id);
    get.onsuccess = () => {
      const session = get.result;
      if (session) { session.name = name; store.put(session); }
    };
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
  });
}

// Supprime une session ET tous ses points et son trajet (cascade).
export async function deleteSession(id) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(['sessions', 'points', 'track'], 'readwrite');
    t.objectStore('sessions').delete(id);
    for (const storeName of ['points', 'track']) {
      const store = t.objectStore(storeName);
      const cursor = store.index('sessionId').openKeyCursor(IDBKeyRange.only(id));
      cursor.onsuccess = () => {
        const cur = cursor.result;
        if (cur) { store.delete(cur.primaryKey); cur.continue(); }
      };
    }
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
  });
}

export function addTrackPoint(point) {
  return tx('track', 'readwrite', s => s.add(point));
}

export function getAllTrack() {
  return tx('track', 'readonly', s => s.getAll());
}

export function getAllPoints() {
  return tx('points', 'readonly', s => s.getAll());
}

export function getAllSessions() {
  return tx('sessions', 'readonly', s => s.getAll());
}
