import { Router } from 'express'
import express from 'express'
import { asyncH, ApiError } from '../middleware/error.js'
import { requireRole } from '../middleware/auth.js'
import {
  listDrafts, getDraft, saveVersion, voidVersion, reopenFromVersion,
  previewFinalize, finalize, getDiff,
  uploadAttachment, downloadCurrentAttachment, downloadVersionAttachment,
  listMaskRules, updateMaskRules,
} from '../services/draftingService.js'

const router = Router()
const firm = requireRole('admin', 'agent', 'reviewer')

const DTYPE = /^technical_disclosure|claims|specification$/

function dtypeParam(req, _res, next) {
  if (!DTYPE.test(req.params.dtype)) return next(new ApiError(400, 'BAD_REQUEST', `未知文书类型「${req.params.dtype}」`))
  next()
}

// 三类文书概览（客户可见本案件脱敏版；不存在的文书返回 exists=false，供前端区分空态）
router.get('/cases/:id/drafts', asyncH(async (req, res) => {
  res.json({ data: await listDrafts(req.user, Number(req.params.id)) })
}))

router.get('/cases/:id/drafts/:dtype', dtypeParam, asyncH(async (req, res) => {
  res.json({ data: await getDraft(req.user, Number(req.params.id), req.params.dtype) })
}))

// 保存即版本：携带 parent_id 做三路合并；段落冲突 → 409 PARAGRAPH_CONFLICT + 逐段冲突清单
router.post('/cases/:id/drafts/:dtype/versions', dtypeParam, asyncH(async (req, res) => {
  const r = await saveVersion(req.user, Number(req.params.id), req.params.dtype, req.body || {})
  res.status(201).json({ data: r })
}))

// 作废某个版本（原因必填留痕）；最后一个有效版本作废后 current_version_id 置空 → 「草稿全部作废」空态
router.post('/cases/:id/drafts/:dtype/void', dtypeParam, firm, asyncH(async (req, res) => {
  res.json({ data: await voidVersion(req.user, Number(req.params.id), req.params.dtype, Number(req.body?.version_id), { reason: req.body?.reason }) })
}))

// 从任一历史版本（含已作废版本）重开
router.post('/cases/:id/drafts/:dtype/reopen', dtypeParam, asyncH(async (req, res) => {
  res.status(201).json({ data: await reopenFromVersion(req.user, Number(req.params.id), req.params.dtype, {
    from_version_id: Number(req.body?.from_version_id), summary: req.body?.summary || '',
  }) })
}))

router.post('/cases/:id/drafts/:dtype/finalize-preview', dtypeParam, firm, asyncH(async (req, res) => {
  res.json({ data: await previewFinalize(req.user, Number(req.params.id), req.params.dtype, req.body || {}) })
}))

// 定稿：可同时按官文同一套口径生成「定稿提交」期限；落点逾期走二次确认
router.post('/cases/:id/drafts/:dtype/finalize', dtypeParam, firm, asyncH(async (req, res) => {
  const r = await finalize(req.user, Number(req.params.id), req.params.dtype, req.body || {})
  res.status(r.noop ? 200 : 201).json({ data: r })
}))

router.get('/cases/:id/drafts/:dtype/diff', dtypeParam, asyncH(async (req, res) => {
  res.json({ data: await getDiff(req.user, Number(req.params.id), req.params.dtype, Number(req.query.from), Number(req.query.to)) })
}))

// 附件原件：原始字节直送（文件本体不入库；元数据里只有 object_key）。
// 文件名经 X-File-Name 头传递，避免引入 multipart 依赖。
router.post(
  '/cases/:id/drafts/:dtype/attachments',
  dtypeParam,
  express.raw({ type: () => true, limit: '20mb' }),
  asyncH(async (req, res) => {
    const filename = req.get('X-File-Name') ? decodeURIComponent(req.get('X-File-Name')) : '附件原件'
    const contentType = req.get('X-Content-Type') || req.get('Content-Type') || 'application/octet-stream'
    res.status(201).json({
      data: await uploadAttachment(req.user, Number(req.params.id), req.params.dtype, req.body, { filename, contentType }),
    })
  })
)

router.get('/attachments/:id/download', asyncH(async (req, res) => {
  const f = await downloadCurrentAttachment(req.user, Number(req.params.id))
  res.set(f.headers)
  res.end(f.buffer)
}))

router.get('/draft-versions/:vid/download', asyncH(async (req, res) => {
  const f = await downloadVersionAttachment(req.user, Number(req.params.vid))
  res.set(f.headers)
  res.end(f.buffer)
}))

// 脱敏规则（仅所内可见/管理员可改）；改规则追加新版本，历史版本快照不回溯
router.get('/mask-rules', firm, asyncH(async (_req, res) => {
  res.json({ data: await listMaskRules() })
}))
router.post('/mask-rules', requireRole('admin'), asyncH(async (req, res) => {
  res.status(201).json({ data: await updateMaskRules(req.user, { rules: req.body?.rules, note: req.body?.note || '' }) })
}))

export default router
