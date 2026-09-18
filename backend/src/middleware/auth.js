import jwt from 'jsonwebtoken'
import crypto from 'node:crypto'
import { config } from '../config.js'
import { query } from '../db.js'
import { redis } from '../redis.js'
import { ApiError } from './error.js'

export function signToken(user) {
  const jti = crypto.randomUUID()
  return jwt.sign({ sub: user.id, jti }, config.jwtSecret, { expiresIn: config.tokenTtlSec })
}

export async function authRequired(req, _res, next) {
  try {
    const h = req.get('Authorization') || ''
    const token = h.startsWith('Bearer ') ? h.slice(7) : null
    if (!token) throw new ApiError(401, 'UNAUTHORIZED', '未登录或登录已过期')
    let payload
    try {
      payload = jwt.verify(token, config.jwtSecret)
    } catch {
      throw new ApiError(401, 'UNAUTHORIZED', '登录状态无效，请重新登录')
    }
    if (await redis().get(`bl:${payload.jti}`)) {
      throw new ApiError(401, 'UNAUTHORIZED', '登录状态已注销，请重新登录')
    }
    const rows = await query('SELECT id, username, name, role, client_id FROM users WHERE id = ?', [payload.sub])
    if (!rows.length) throw new ApiError(401, 'UNAUTHORIZED', '账号不存在或已停用')
    req.user = rows[0]
    req.tokenId = payload.jti
    next()
  } catch (e) {
    next(e)
  }
}

export function requireRole(...roles) {
  return (req, _res, next) => {
    if (!roles.includes(req.user.role)) {
      return next(new ApiError(403, 'ROLE_DENIED', '当前角色无权执行此操作'))
    }
    next()
  }
}

// 客户间数据隔离：客户管理员只能访问本客户数据，越权一律 403（前端渲染错误态而非空白页）
export function assertClientAccess(user, clientId) {
  if (user.role === 'client_admin' && Number(user.client_id) !== Number(clientId)) {
    throw new ApiError(403, 'FORBIDDEN', '无权访问其他客户的数据')
  }
}
