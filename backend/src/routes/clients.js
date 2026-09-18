import { Router } from 'express'
import { query, insert, tx } from '../db.js'
import { asyncH, ApiError } from '../middleware/error.js'
import { requireRole, assertClientAccess } from '../middleware/auth.js'
import { maskClientForViewer } from '../lib/mask.js'
import { nowIso } from '../lib/dates.js'
import { bumpDash } from '../services/dashboardService.js'

const router = Router()

// 客户列表：所内角色看全部（按脱敏规则），客户管理员只看本客户
router.get(
  '/',
  asyncH(async (req, res) => {
    const scoped = req.user.role === 'client_admin'
    const clients = scoped
      ? await query('SELECT * FROM clients WHERE id = ?', [req.user.client_id])
      : await query('SELECT * FROM clients ORDER BY id')
    const out = []
    for (const cl of clients) {
      const active = await query("SELECT COUNT(*) AS n FROM cases WHERE client_id = ? AND status != '委托中'", [cl.id])
      const total = await query('SELECT COUNT(*) AS n FROM cases WHERE client_id = ?', [cl.id])
      const contracts = await query("SELECT COUNT(*) AS n FROM contracts WHERE client_id = ? AND status = '已签署'", [cl.id])
      out.push({
        ...maskClientForViewer(cl, req.user, Number(active[0].n)),
        case_count: Number(total[0].n),
        has_contract: Number(contracts[0].n) > 0,
      })
    }
    res.json({ data: out })
  })
)

// 客户建档（管理员）
router.post(
  '/',
  requireRole('admin'),
  asyncH(async (req, res) => {
    const { name, short_code, contact_name = '', contact_phone = '', contact_email = '' } = req.body || {}
    if (!name || !short_code) throw new ApiError(400, 'BAD_REQUEST', '缺少必填字段：name / short_code')
    const now = nowIso()
    const id = await tx(async (d) => {
      const max = await d.query('SELECT COALESCE(MAX(id), 0) AS m FROM clients')
      const code = `KH-${String(Number(max[0].m) + 1).padStart(4, '0')}`
      return d.insert(
        'INSERT INTO clients (code, name, short_code, contact_name, contact_phone, contact_email, status, created_at) VALUES (?,?,?,?,?,?,?,?)',
        [code, name, short_code, contact_name, contact_phone, contact_email, '已建档', now]
      )
    })
    await bumpDash()
    const rows = await query('SELECT * FROM clients WHERE id = ?', [id])
    res.status(201).json({ data: rows[0] })
  })
)

// 客户详情（含合同与案件，链路一页呈现：建档 → 签约 → 立项办案）
router.get(
  '/:id',
  asyncH(async (req, res) => {
    const id = Number(req.params.id)
    assertClientAccess(req.user, id)
    const rows = await query('SELECT * FROM clients WHERE id = ?', [id])
    if (!rows.length) throw new ApiError(404, 'NOT_FOUND', '客户不存在')
    const cl = rows[0]
    const active = await query("SELECT COUNT(*) AS n FROM cases WHERE client_id = ? AND status != '委托中'", [id])
    const contracts = await query('SELECT * FROM contracts WHERE client_id = ? ORDER BY id DESC', [id])
    const cases = await query(
      `SELECT c.id, c.case_no, c.title, c.ctype, c.status, c.priority, c.updated_at, u.name AS agent_name
       FROM cases c LEFT JOIN users u ON u.id = c.agent_id WHERE c.client_id = ? ORDER BY c.id DESC`,
      [id]
    )
    res.json({
      data: {
        client: maskClientForViewer(cl, req.user, Number(active[0].n)),
        contracts,
        cases,
      },
    })
  })
)

// 签订委托合同（管理员）：签约后客户状态变为「已签约」，案件方可立项
router.post(
  '/:id/contracts',
  requireRole('admin'),
  asyncH(async (req, res) => {
    const id = Number(req.params.id)
    const { title, amount = 0 } = req.body || {}
    if (!title) throw new ApiError(400, 'BAD_REQUEST', '缺少合同标的（title）')
    const clients = await query('SELECT id FROM clients WHERE id = ?', [id])
    if (!clients.length) throw new ApiError(404, 'NOT_FOUND', '客户不存在')
    const dup = await query("SELECT id FROM contracts WHERE client_id = ? AND status = '已签署'", [id])
    if (dup.length) throw new ApiError(409, 'CONTRACT_EXISTS', '该客户已存在生效中的委托合同，无需重复签订')
    const now = nowIso()
    const cid = await tx(async (d) => {
      const max = await d.query('SELECT COALESCE(MAX(id), 0) AS m FROM contracts')
      const contractNo = `HT-${now.slice(0, 4)}-${String(Number(max[0].m) + 1).padStart(3, '0')}`
      const newId = await d.insert(
        'INSERT INTO contracts (contract_no, client_id, title, amount, status, signed_at, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)',
        [contractNo, id, title, amount, '已签署', now, req.user.id, now]
      )
      await d.query("UPDATE clients SET status = '已签约' WHERE id = ?", [id])
      return newId
    })
    await bumpDash()
    const rows = await query('SELECT * FROM contracts WHERE id = ?', [cid])
    res.status(201).json({ data: rows[0] })
  })
)

// 查看客户全称（二次确认 + 理由，留痕）——脱敏数据的唯一解封装口
router.post(
  '/:id/reveal',
  requireRole('admin', 'agent', 'reviewer'),
  asyncH(async (req, res) => {
    const id = Number(req.params.id)
    const { reason, case_id = null } = req.body || {}
    if (!reason || String(reason).trim().length < 2) {
      throw new ApiError(400, 'BAD_REQUEST', '请填写查看理由（至少 2 个字），本次查看将留痕')
    }
    const rows = await query('SELECT * FROM clients WHERE id = ?', [id])
    if (!rows.length) throw new ApiError(404, 'NOT_FOUND', '客户不存在')
    await insert('INSERT INTO unmask_logs (user_id, user_name, client_id, case_id, reason, ip, created_at) VALUES (?,?,?,?,?,?,?)', [
      req.user.id,
      req.user.name,
      id,
      case_id,
      String(reason).trim(),
      req.ip || '',
      nowIso(),
    ])
    res.json({ data: { name: rows[0].name, logged: true } })
  })
)

export default router
