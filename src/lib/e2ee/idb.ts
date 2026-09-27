/**
 * A tiny IndexedDB key-value store for CryptoKey objects.
 *
 * IndexedDB, not localStorage, because it can hold a CryptoKey itself via
 * structured clone. The keys stored here are imported as NON-extractable, so
 * page script can use them but can never read their bytes back out - an XSS
 * could still decrypt while it runs, but could not walk away with the key.
 */

const DB_NAME = 'transmission-keys';
const STORE = 'keys';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function run<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = action(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export function idbGet<T>(key: string): Promise<T | undefined> {
  return run('readonly', (store) => store.get(key) as IDBRequest<T | undefined>);
}

export async function idbSet(key: string, value: unknown): Promise<void> {
  await run('readwrite', (store) => store.put(value, key));
}

export async function idbClear(): Promise<void> {
  await run('readwrite', (store) => store.clear());
}
