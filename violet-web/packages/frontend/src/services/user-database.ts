const DB_NAME = 'violet-user-database';
const DB_VERSION = 3;

export const USER_STORES = {
  bookmarkGroups: 'bookmark-groups',
  bookmarkArticles: 'bookmark-articles',
  bookmarkArtists: 'bookmark-artists',
  bookmarkCrops: 'bookmark-crops',
  readHistory: 'read-history',
  bookmarkSync: 'bookmark-sync',
  sharedActivity: 'shared-activity',
} as const;

type UserStoreName = (typeof USER_STORES)[keyof typeof USER_STORES];

let dbInstance: IDBDatabase | null = null;

function openUserDB(): Promise<IDBDatabase> {
  if (dbInstance) return Promise.resolve(dbInstance);

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      for (const storeName of Object.values(USER_STORES)) {
        if (!db.objectStoreNames.contains(storeName)) {
          db.createObjectStore(storeName, { keyPath: 'Id' });
        }
      }
    };

    request.onsuccess = () => {
      dbInstance = request.result;
      dbInstance.onversionchange = () => { dbInstance?.close(); dbInstance = null; };
      dbInstance.onclose = () => {
        dbInstance = null;
      };
      resolve(dbInstance);
    };

    request.onerror = () => reject(request.error);
  });
}

// Browser metadata is committed in one transaction. The backend adapter
// journals its HTTP apply plan here so interrupted operations can resume.
export async function transactBookmarkSync<T>(
  action: (articles: any[], state: any, articlesStore: IDBObjectStore, metaStore: IDBObjectStore) => T,
): Promise<T> {
  const db = await openUserDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([USER_STORES.bookmarkArticles, USER_STORES.bookmarkSync], 'readwrite');
    const articlesStore = tx.objectStore(USER_STORES.bookmarkArticles);
    const metaStore = tx.objectStore(USER_STORES.bookmarkSync);
    const articlesRequest = articlesStore.getAll();
    const stateRequest = metaStore.get('state');
    let completed = 0;
    let result: T;
    const ready = () => {
      if (++completed !== 2) return;
      try {
        result = action(articlesRequest.result, stateRequest.result, articlesStore, metaStore);
      } catch (error) {
        tx.abort();
        reject(error);
      }
    };
    articlesRequest.onsuccess = ready;
    stateRequest.onsuccess = ready;
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(tx.error ?? new Error('Bookmark transaction aborted'));
    tx.onerror = () => reject(tx.error);
  });
}

export async function getBookmarkSyncState<T>(): Promise<T | null> {
  const db = await openUserDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(USER_STORES.bookmarkSync, 'readonly');
    const request = tx.objectStore(USER_STORES.bookmarkSync).get('state');
    request.onsuccess = () => resolve((request.result as T | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
}

export async function getAllUserItems<T>(storeName: UserStoreName): Promise<T[]> {
  const db = await openUserDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result as T[]);
    request.onerror = () => reject(request.error);
  });
}

export async function putUserItem<T>(storeName: UserStoreName, item: T): Promise<void> {
  const db = await openUserDB();

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const request = store.put(item);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function putUserItems<T>(storeName: UserStoreName, items: T[]): Promise<void> {
  if (items.length === 0) return;

  const db = await openUserDB();

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    for (const item of items) {
      store.put(item);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteUserItem(storeName: UserStoreName, id: number): Promise<void> {
  const db = await openUserDB();

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const request = store.delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function replaceUserItems<T extends { Id: number | string }>(
  storeName: UserStoreName,
  items: T[],
): Promise<void> {
  const db = await openUserDB();

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    store.clear();
    for (const item of items) {
      store.put(item);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
