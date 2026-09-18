// 应用外壳缓存：断网时页面本体可打开。
// /api 请求不经过这里——数据的离线缓存与变更队列由应用层（src/offline.js）精细控制，
// 避免「拿旧状态糊弄」：缓存数据一定带时间戳并以横幅明示。
const CACHE = 'patent-shell-v1'
const CORE = ['/', '/index.html']

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)))
  self.skipWaiting()
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  )
  self.clients.claim()
})

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  if (url.pathname.startsWith('/api/')) return // 交给应用层
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => caches.match('/index.html')))
    return
  }
  e.respondWith(
    caches.match(e.request).then(
      (hit) =>
        hit ||
        fetch(e.request).then((resp) => {
          const copy = resp.clone()
          caches.open(CACHE).then((c) => c.put(e.request, copy))
          return resp
        })
    )
  )
})
