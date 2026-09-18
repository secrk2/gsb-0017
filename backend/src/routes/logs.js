import { Router } from 'express'
import { query } from '../db.js'
import { asyncH } from '../middleware/error.js'
import { requireRole } from '../middleware/auth.js'

const router = Router()

// 脱敏查看留痕（管理员/审核员可查）
router.get(
  '/unmask',
  requireRole('admin', 'reviewer'),
  asyncH(async (req, res) => {
    const rows = await query(
      `SELECT ul.*, c.short_code, c.code AS client_code
       FROM unmask_logs ul JOIN clients c ON c.id = ul.client_id
       ORDER BY ul.id DESC LIMIT 200`
    )
    res.json({ data: rows })
  })
)

// 案件流转事件（所内角色可查）
router.get(
  '/events',
  requireRole('admin', 'agent', 'reviewer'),
  asyncH(async (req, res) => {
    const rows = await query(
      `SELECT e.*, c.case_no, c.title AS case_title
       FROM case_events e JOIN cases c ON c.id = e.case_id
       ORDER BY e.id DESC LIMIT 200`
    )
    res.json({ data: rows })
  })
)

export default router
