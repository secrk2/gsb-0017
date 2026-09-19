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

// 附件原件：原始字节上传（不经 multipart，文件名走 X-File-Name；与服务端 express.raw 对应）
export async function uploadRaw(path, file) {
  const resp = await fetch(`/api${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${store.token}`,
      'Content-Type': file.type || 'application/octet-stream',
      'X-File-Name': encodeURIComponent(file.name),
      'X-Content-Type': file.type || 'application/octet-stream',
    },
    body: file,
  })
  const json = await resp.json().catch(() => null)
  if (!resp.ok) throw new ApiError(resp.status, json?.error?.code || 'ERROR', json?.error?.message || '上传失败')
  return { data: json.data }
}

// 附件下载：拿到字节后由调用方决定保存名
export async function downloadBytes(path) {
  const resp = await fetch(`/api${path}`, { headers: { Authorization: `Bearer ${store.token}` } })
  if (!resp.ok) throw new ApiError(resp.status, 'DOWNLOAD_FAILED', `下载失败（${resp.status}）`)
  const blob = await resp.blob()
  const name = parseFilename(resp.headers.get('Content-Disposition')) || '附件原件'
  return { blob, name, version: resp.headers.get('X-File-Version') }
}

export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

function parseFilename(disposition) {
  if (!disposition) return null
  const utf8 = disposition.match(/filename\*=UTF-8''([^;]+)/i)
  if (utf8) return decodeURIComponent(utf8[1])
  const plain = disposition.match(/filename="?([^";]+)"?/i)
  return plain ? plain[1] : null
}

// 带认证的文件下载（CSV 导出）：拿到文本后由调用方触发浏览器保存
export async function downloadText(path, filename) {  const resp = await fetch(`/api${path}`, { headers: { Authorization: `Bearer ${store.token}` } })
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
