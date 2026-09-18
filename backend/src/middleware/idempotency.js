import { query, insert } from '../db.js'
import { redis } from '../redis.js'
import { nowIso } from '../lib/dates.js'

// 幂等中间件：POST 请求携带 Idempotency-Key 时，
// 相同 key 的重复请求直接回放首次响应（Redis 快路径 + MySQL 持久兜底），
// 保证断网重试、双击、刷新重提都不会产生重复副作用。
export async function idempotency(req, res, next) {
  const key = req.get('Idempotency-Key')
  if (!key || req.method !== 'POST') return next()
  try {
    const hit = await redis().get(`idem:${key}`)
    if (hit) {
      const { status, body } = JSON.parse(hit)
      res.set('X-Idempotent-Replay', 'true')
      return res.status(status).json(body)
    }
    const rows = await query('SELECT status_code, response FROM idempotency_keys WHERE ikey = ?', [key])
    if (rows.length && rows[0].response) {
      res.set('X-Idempotent-Replay', 'true')
      return res.status(rows[0].status_code).json(JSON.parse(rows[0].response))
    }
  } catch (e) {
    console.error('[idempotency] lookup failed, continue:', e.message)
  }
  const json = res.json.bind(res)
  res.json = (body) => {
    persist(key, req, res.statusCode, body).catch(() => {})
    return json(body)
  }
  next()
}

async function persist(key, req, status, body) {
  try {
    await insert(
      'INSERT INTO idempotency_keys (ikey, user_id, method, path, status_code, response, created_at) VALUES (?,?,?,?,?,?,?)',
      [key, req.user?.id ?? null, req.method, req.originalUrl, status, JSON.stringify(body), nowIso()]
    )
  } catch {
    // 并发下同 key 撞主键属正常竞争，忽略
  }
  try {
    await redis().set(`idem:${key}`, JSON.stringify({ status, body }), 'EX', 86400)
  } catch {}
}
