import { Router } from 'express'
import { asyncH } from '../middleware/error.js'
import { requireRole } from '../middleware/auth.js'
import {
  listCaseWriting, createDoc, saveVersion, voidDoc, restartFrom,
  getDocDetail, getVersion, getDiff, resolveConflicts,
  initAttachment, putAttachmentBytes, markAttachmentParsed, downloadAttachmentVersion,
  previewFinalDeadline, listMaskRules, createMaskRules,
} from '../services/writingService.js'

const router = Router()
const firm = requireRole('admin', 'agent', 'reviewer')

// 案件撰稿总览（三类文档各自状态：none 还没有草稿 / active / void 草稿全部作废）
router.get('/cases/:id/writing', asyncH(async (req, res) => {
  res.json({ data: await listCaseWriting(req.user, Number(req.params.id)) })
}))

// 新建某类文档的草稿链
router.post('/cases/:id/writing/:kind', asyncH(async (req, res) => {
  res.status(201).json({ data: await createDoc(req.user, Number(req.params.id), req.params.kind, req.body || {}) })
}))

// 保存版本（带 base_version_id 做乐观并发；双方改同一段 → 409 PARAGRAPH_CONFLICT 带取舍数据）
router.post('/cases/:id/writing/:kind/save', asyncH(async (req, res) => {
  const r = await saveVersion(req.user, Number(req.params.id), req.params.kind, req.body || {})
  res.status(201).json({ data: r })
}))

// 从历史/作废版本重开一条新链
router.post('/cases/:id/writing/:kind/restart', asyncH(async (req, res) => {
  res.status(201).json({ data: await restartFrom(req.user, Number(req.params.id), req.params.kind, req.body || {}) })
}))

// 定稿提交期限预览（与官文期限同一套起算/天数口径）
router.post('/cases/:id/writing/:kind/final-deadline-preview', firm, asyncH(async (req, res) => {
  res.json({ data: await previewFinalDeadline(req.user, Number(req.params.id), req.body || {}) })
}))

// 文档详情：版本链、待取舍冲突、附件
router.get('/writing/docs/:docId', asyncH(async (req, res) => {
  res.json({ data: await getDocDetail(req.user, Number(req.params.docId), { maskPreview: req.query.view === 'masked' }) })
}))

// 作废（原因必填留痕；作废链仍可从其任一版本重开）
router.post('/writing/docs/:docId/void', asyncH(async (req, res) => {
  res.json({ data: await voidDoc(req.user, Number(req.params.docId), req.body || {}) })
}))

// 段落级冲突取舍：逐段 incoming/pending/merged → 生成「冲突合并」版本
router.post('/writing/docs/:docId/conflicts/resolve', asyncH(async (req, res) => {
  res.status(201).json({ data: await resolveConflicts(req.user, Number(req.params.docId), req.body || {}) })
}))

// 单个历史版本（客户取版本自带脱敏快照）
router.get('/writing/versions/:versionId', asyncH(async (req, res) => {
  res.json({ data: await getVersion(req.user, Number(req.params.versionId)) })
}))

// 两版差异（from 缺省 = 与空文档比，即首版全文）
router.get('/writing/docs/:docId/diff', asyncH(async (req, res) => {
  const r = await getDiff(req.user, Number(req.params.docId), { from: req.query.from, to: req.query.to })
  res.json({ data: r })
}))

// ---- 附件：两阶段上传到对象存储，原件不入库；换版不可变，旧版可下载 ----

// 第一阶段：登记版本（解析中）+ 领取一次性上传令牌与不可变 object_key
router.post('/writing/docs/:docId/attachments/init', asyncH(async (req, res) => {
  res.status(201).json({ data: await initAttachment(req.user, Number(req.params.docId), req.body || {}) })
}))

// 第二阶段：二进制直传（raw body 由 app.js 在 JSON 之前按路径挂 express.raw 解析）
router.post('/writing/attachments/upload/:versionId', asyncH(async (req, res) => {
  const token = req.get('X-Upload-Token') || String(req.query.token || '')
  const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
  const r = await putAttachmentBytes(req.user, Number(req.params.versionId), buf, token)
  res.status(201).json({ data: r })
}))

// 模拟解析流水线回填（OCR/结构化抽取完成或失败）
router.post('/writing/attachments/versions/:versionId/parsed', asyncH(async (req, res) => {
  res.json({ data: await markAttachmentParsed(req.user, Number(req.params.versionId), req.body || {}) })
}))

// 下载附件指定版本（缺省最新版；旧版本 key 永不删改）
router.get('/writing/attachments/:attachmentId/download', asyncH(async (req, res) => {
  const r = await downloadAttachmentVersion(req.user, Number(req.params.attachmentId), req.query.version)
  res.setHeader('Content-Type', r.content_type)
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(r.filename)}`)
  res.setHeader('X-Attachment-Version', String(r.version_no))
  res.send(r.buf)
}))

// ---- 脱敏规则版本（管理员发布新版；历史版本按各自快照呈现，不回改）----
router.get('/writing/mask-rules', firm, asyncH(async (req, res) => {
  res.json({ data: await listMaskRules() })
}))
router.post('/writing/mask-rules', requireRole('admin'), asyncH(async (req, res) => {
  res.status(201).json({ data: await createMaskRules(req.user, req.body || {}) })
}))

export default router
