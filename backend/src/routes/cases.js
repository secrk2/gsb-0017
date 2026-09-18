import { Router } from 'express'
import { asyncH } from '../middleware/error.js'
import { requireRole } from '../middleware/auth.js'
import { listCases, getCaseDetail, createCase, transitionCase } from '../services/caseService.js'
import { addDeadline, addFee } from '../services/workflowService.js'

const router = Router()

router.get(
  '/',
  asyncH(async (req, res) => {
    const { status, client_id, mine } = req.query
    res.json({ data: await listCases(req.user, { status, client_id, mine: mine === '1' }) })
  })
)

// 创建委托案件（所内角色）。客户端必须携带 client_uuid 作为幂等键。
router.post(
  '/',
  requireRole('admin', 'agent', 'reviewer'),
  asyncH(async (req, res) => {
    const result = await createCase(req.user, req.body)
    res.status(result.deduped ? 200 : 201).json({ data: result })
  })
)

router.get(
  '/:id',
  asyncH(async (req, res) => {
    res.json({ data: await getCaseDetail(req.user, Number(req.params.id)) })
  })
)

// 状态流转（非法回退/跳级在此被状态机拦截并说明原因）
router.post(
  '/:id/transition',
  requireRole('admin', 'agent', 'reviewer'),
  asyncH(async (req, res) => {
    res.json({ data: await transitionCase(req.user, Number(req.params.id), req.body) })
  })
)

router.post(
  '/:id/deadlines',
  requireRole('admin', 'agent', 'reviewer'),
  asyncH(async (req, res) => {
    res.status(201).json({ data: await addDeadline(req.user, Number(req.params.id), req.body) })
  })
)

router.post(
  '/:id/fees',
  requireRole('admin', 'agent', 'reviewer'),
  asyncH(async (req, res) => {
    res.status(201).json({ data: await addFee(req.user, Number(req.params.id), req.body) })
  })
)

export default router
