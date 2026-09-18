import { Router } from 'express'
import { asyncH } from '../middleware/error.js'
import { requireRole } from '../middleware/auth.js'
import {
  registerDoc, archiveDoc, withdrawDoc, previewDeadline, getCalendarRange, listDocsForCase,
} from '../services/docService.js'
import { listHolidays } from '../services/holidayService.js'
import { assertCaseAccess } from '../services/caseService.js'
import { DOC_TYPES, DOC_GROUPS, ANCHOR_LABELS, DAY_BASIS_LABELS } from '../lib/docTypes.js'

const router = Router()
const firm = requireRole('admin', 'agent', 'reviewer')

// 官文类型字典与期限口径文案（前端登记表单渲染，避免口径文案两边漂移）
router.get(
  '/doc-types',
  asyncH(async (req, res) => {
    res.json({ data: { types: DOC_TYPES, groups: DOC_GROUPS, anchor_labels: ANCHOR_LABELS, day_basis_labels: DAY_BASIS_LABELS } })
  })
)

// 登记官文（可驱动状态机流转 + 自动生成法定期限；落点逾期二次确认留痕）
router.post(
  '/cases/:id/docs',
  firm,
  asyncH(async (req, res) => {
    res.status(201).json({ data: await registerDoc(req.user, Number(req.params.id), req.body) })
  })
)

// 本案官文清单
router.get(
  '/cases/:id/docs',
  asyncH(async (req, res) => {
    const caseId = Number(req.params.id)
    await assertCaseAccess(req.user, caseId)
    res.json({ data: await listDocsForCase(caseId) })
  })
)

// 期限到期日预览（登记表单实时调用）
router.post(
  '/cases/:id/deadline-preview',
  firm,
  asyncH(async (req, res) => {
    res.json({ data: await previewDeadline(req.user, Number(req.params.id), req.body) })
  })
)

// 官文归档（幂等）
router.post(
  '/docs/:id/archive',
  firm,
  asyncH(async (req, res) => {
    res.json({ data: await archiveDoc(req.user, Number(req.params.id)) })
  })
)

// 官文撤回（原因必填留痕）
router.post(
  '/docs/:id/withdraw',
  firm,
  asyncH(async (req, res) => {
    res.json({ data: await withdrawDoc(req.user, Number(req.params.id), req.body || {}) })
  })
)

// 日历区间：区间内官文（发文/收到日落点）+ 期限到期日落点
router.get(
  '/calendar',
  asyncH(async (req, res) => {
    const { from, to, basis } = req.query
    res.json({ data: await getCalendarRange(req.user, { from, to, basis }) })
  })
)

// 节假日/调休补班（日历角标）
router.get(
  '/holidays',
  asyncH(async (req, res) => {
    res.json({ data: await listHolidays(req.query.from, req.query.to) })
  })
)

export default router
