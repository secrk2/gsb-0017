import { store } from './store.js'
import * as off from './offline.js'
import { uuid } from './utils.js'

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

async function raw(method, path, body, headers = {}) {
  const h = { ...headers }
  if (body !== undefined) h['Content-Type'] = 'application/json'
  if (store.token) h.Authorization = `Bearer ${store.token}`
  let resp
  try {
    resp = await fetch(`/api${path}`, {
      method,
      headers: h,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch {
    throw new ApiError(0, 'NETWORK', '网络连接失败')
  }
  const json = await resp.json().catch(() => null)
  if (resp.status === 401 && store.token) {
    // 登录态失效：清理并回登录页
    store.logout()
    location.href = '/login'
    throw new ApiError(401, 'UNAUTHORIZED', '登录已过期，请重新登录')
  }
  if (!resp.ok) {
    throw new ApiError(resp.status, json?.error?.code || 'ERROR', json?.error?.message || `请求失败（${resp.status}）`, json?.error?.details)
  }
  return { data: json?.data, headers: resp.headers }
}

// GET：成功即写缓存；断网时回退缓存并标记 stale（界面必须明示，绝不拿旧数据冒充新数据）
export async function get(path, { cacheKey } = {}) {
  try {
    const { data } = await raw('GET', path)
    store.online = true
    if (cacheKey) await off.cacheSet(cacheKey, data).catch(() => {})
    return { data, stale: false }
  } catch (e) {
    if (e.code === 'NETWORK') {
      store.online = false
      if (cacheKey) {
        const hit = await off.cacheGet(cacheKey).catch(() => null)
        if (hit) return { data: hit.data, stale: true, cachedAt: hit.ts }
      }
    }
    throw e
  }
}

// 变更：携带幂等键；断网且声明了 offlineOp 时进入待同步队列（不丢失、不假装成功）
export async function mutate(method, path, body, { offlineOp } = {}) {
  const key = uuid()
  try {
    const { data } = await raw(method, path, body, { 'Idempotency-Key': key })
    store.online = true
    return { data, queued: false }
  } catch (e) {
    if (e.code === 'NETWORK' && offlineOp) {
      store.online = false
      await off.outboxAdd({ key, ...offlineOp, ts: Date.now() })
      await refreshOutboxCount()
      return { queued: true, key }
    }
    throw e
  }
}

export async function refreshOutboxCount() {
  const ops = await off.outboxAll().catch(() => [])
  store.outboxCount = ops.length
  return ops
}

// 恢复网络后统一回放：服务端按 key 幂等去重、按状态机合并，冲突会逐条带回
export async function flushOutbox() {
  const ops = await off.outboxAll().catch(() => [])
  if (!ops.length) return null
  try {
    const { data } = await raw('POST', '/sync/batch', {
      ops: ops.map((o) => ({ key: o.key, op: o.op, payload: o.payload })),
    })
    for (const o of ops) await off.outboxRemove(o.key).catch(() => {})
    await refreshOutboxCount()
    return data.results
  } catch {
    return null
  }
}

export async function login(username, password) {
  const { data } = await raw('POST', '/auth/login', { username, password })
  store.setAuth(data.token, data.user)
  return data.user
}

export async function logout() {
  try {
    await raw('POST', '/auth/logout')
  } catch {}
  store.logout()
}

// 带认证的文件下载（CSV 导出）：拿到文本后由调用方触发浏览器保存
export async function downloadText(path, filename) {
  const resp = await fetch(`/api${path}`, { headers: { Authorization: `Bearer ${store.token}` } })
  if (!resp.ok) throw new ApiError(resp.status, 'DOWNLOAD_FAILED', `导出失败（${resp.status}）`)
  const text = await resp.text()
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
