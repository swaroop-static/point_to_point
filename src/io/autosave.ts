import type { ImageId, Project } from '../core/types';

/**
 * Crash-recovery autosave in IndexedDB. Stays on this device and browser.
 *
 * Stores the project JSON plus the original image files (so a recovered
 * session is complete, not just annotations). Browsers may evict this data
 * under storage pressure or when site data is cleared, and private windows
 * may disable it, so it is a safety net, not a substitute for Save project.
 * All failures are swallowed and reported once via the returned status.
 */

const DB_NAME = 'annotate-anything';
const DB_VERSION = 1;

export interface Session {
  /** Raw JSON; the caller must run it through parseProjectJson before trusting it. */
  projectJson: string;
  files: Map<ImageId, Blob>;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB unavailable.')); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('project')) db.createObjectStore('project');
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Could not open IndexedDB.'));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed.'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted (storage full?).'));
  });
}

/** Replace the saved session. Files already stored under the same id are kept; orphans are deleted. */
export async function saveSession(project: Project, getFile: (id: ImageId) => Blob | null): Promise<void> {
  const db = await open();
  try {
    const live = new Set([...project.images.map((i) => i.id), ...(project.meshes ?? []).map((m) => m.id)]);
    const existing = await new Promise<IDBValidKey[]>((resolve, reject) => {
      const r = db.transaction('files').objectStore('files').getAllKeys();
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const tx = db.transaction(['project', 'files'], 'readwrite');
    tx.objectStore('project').put(JSON.stringify(project), 'current');
    const files = tx.objectStore('files');
    for (const k of existing) if (!live.has(String(k))) files.delete(k);
    const have = new Set(existing.map(String));
    for (const id of live) {
      if (have.has(id)) continue;
      const f = getFile(id);
      if (f) files.put(f, id);
    }
    await done(tx);
  } finally {
    db.close();
  }
}

export async function loadSession(): Promise<Session | null> {
  const db = await open();
  try {
    const tx = db.transaction(['project', 'files'], 'readonly');
    const json = await new Promise<unknown>((resolve, reject) => {
      const r = tx.objectStore('project').get('current');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    if (typeof json !== 'string') return null;
    const files = new Map<ImageId, Blob>();
    await new Promise<void>((resolve, reject) => {
      const c = tx.objectStore('files').openCursor();
      c.onsuccess = () => {
        const cur = c.result;
        if (!cur) { resolve(); return; }
        if (cur.value instanceof Blob) files.set(String(cur.key), cur.value);
        cur.continue();
      };
      c.onerror = () => reject(c.error);
    });
    return { projectJson: json, files };
  } finally {
    db.close();
  }
}

export async function clearSession(): Promise<void> {
  const db = await open();
  try {
    const tx = db.transaction(['project', 'files'], 'readwrite');
    tx.objectStore('project').clear();
    tx.objectStore('files').clear();
    await done(tx);
  } finally {
    db.close();
  }
}
