import { config } from './config.js'

let client = null

// 内存实现：接口对齐 ioredis 子集，供本地开发/测试零依赖运行
function createMemoryRedis() {
  const store = new Map()
  const sweep = (k) => {
    const e = store.get(k)
    if (e && e.exp && e.exp < Date.now()) store.delete(k)
  }
  return {
    async get(k) {
      sweep(k)
      return store.get(k)?.v ?? null
    },
    async set(k, v, ...args) {
      let exp = null
      const i = args.findIndex((a) => String(a).toUpperCase() === 'EX')
      if (i >= 0) exp = Date.now() + Number(args[i + 1]) * 1000
      store.set(k, { v: String(v), exp })
      return 'OK'
    },
    async del(...ks) {
      let n = 0
      for (const k of ks.flat()) if (store.delete(k)) n++
      return n
    },
    async incr(k) {
      sweep(k)
      const cur = Number(store.get(k)?.v ?? 0) + 1
      const e = store.get(k)
      store.set(k, { v: String(cur), exp: e?.exp ?? null })
      return cur
    },
    async expire(k, sec) {
      const e = store.get(k)
      if (!e) return 0
      e.exp = Date.now() + sec * 1000
      return 1
    },
    async keys(pattern) {
      const pre = pattern.replace(/\*$/, '')
      const out = []
      for (const k of [...store.keys()]) {
        sweep(k)
        if (store.has(k) && k.startsWith(pre)) out.push(k)
      }
      return out
    },
    async ping() {
      return 'PONG'
    },
    async quit() {},
  }
}

export async function initRedis() {
  if (config.redisUrl === 'memory://') {
    client = createMemoryRedis()
    return client
  }
  const { default: Redis } = await import('ioredis')
  client = new Redis(config.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 2 })
  await client.connect()
  return client
}

export function redis() {
  return client
}
