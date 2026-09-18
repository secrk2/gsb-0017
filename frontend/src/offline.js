// IndexedDB：接口缓存（带时间戳，离线时明示「可能已过期」）+ 变更待同步队列
const DB_NAME = 'patent-cloud'

let dbPromise = null

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains('cache')) db.createObjectStore('cache', { keyPath: 'key' })
        if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'key' })
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }
  return dbPromise
}

const reqp = (r) =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })

export async function cacheSet(key, data) {
  const db = await openDb()
  await reqp(db.transaction('cache', 'readwrite').objectStore('cache').put({ key, data, ts: Date.now() }))
}

export async function cacheGet(key) {
  const db = await openDb()
  return reqp(db.transaction('cache', 'readonly').objectStore('cache').get(key))
}

// op: { key, op, payload, label, ts }
export async function outboxAdd(op) {
  const db = await openDb()
  await reqp(db.transaction('outbox', 'readwrite').objectStore('outbox').put(op))
}

export async function outboxAll() {
  const db = await openDb()
  return (await reqp(db.transaction('outbox', 'readonly').objectStore('outbox').getAll())) || []
}

export async function outboxRemove(key) {
  const db = await openDb()
  await reqp(db.transaction('outbox', 'readwrite').objectStore('outbox').delete(key))
}
