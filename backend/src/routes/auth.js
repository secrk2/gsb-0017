import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { query } from '../db.js'
import { redis } from '../redis.js'
import { signToken, authRequired } from '../middleware/auth.js'
import { asyncH, ApiError } from '../middleware/error.js'
import { config } from '../config.js'

const router = Router()

// 登录限流：每 IP 每分钟 10 次（Redis）
router.post(
  '/login',
  asyncH(async (req, res) => {
    const ip = req.ip || 'unknown'
    const rlKey = `rl:login:${ip}`
    const n = await redis().incr(rlKey)
    if (n === 1) await redis().expire(rlKey, 60)
    if (n > 10) throw new ApiError(429, 'RATE_LIMITED', '尝试过于频繁，请稍后再试')

    const { username, password } = req.body || {}
    if (!username || !password) throw new ApiError(400, 'BAD_REQUEST', '请输入用户名和密码')
    const rows = await query('SELECT * FROM users WHERE username = ?', [username])
    if (!rows.length || !bcrypt.compareSync(password, rows[0].password_hash)) {
      throw new ApiError(401, 'BAD_CREDENTIALS', '用户名或密码错误')
    }
    const u = rows[0]
    const token = signToken(u)
    res.json({
      data: {
        token,
        user: { id: u.id, username: u.username, name: u.name, role: u.role, client_id: u.client_id },
      },
    })
  })
)

router.post(
  '/logout',
  authRequired,
  asyncH(async (req, res) => {
    await redis().set(`bl:${req.tokenId}`, '1', 'EX', config.tokenTtlSec)
    res.json({ data: { ok: true } })
  })
)

router.get(
  '/me',
  authRequired,
  asyncH(async (req, res) => {
    res.json({ data: { user: req.user } })
  })
)

export default router
