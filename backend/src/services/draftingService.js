// 撰稿与交底：技术交底书 / 权利要求草稿 / 说明书定稿 的版本链、段落级并发合并、
// 不可变脱敏快照、定稿（复用官文期限口径）、附件对象存储。
//
// 并发协作模型见 lib/paragraphs.js：保存携带 parent_id，与服务端最新版本三路合并，
// 同一段双方改 → 409 段落级冲突 + 冲突清单，由调用方逐段取舍后重提，不静默覆盖、不锁人。

import crypto from 'node:crypto'
import { query, tx } from '../db.js'
import { ApiError } from '../middleware/error.js'
import { assertClientAccess } from '../middleware/auth.js'
import { draftTypeDef, FINALIZE_DEADLINE_DEFAULTS } from '../lib/draftTypes.js'
import { normalizeParas, normText, parasToContent, mergeParas, resolveConflicts, diffParas, diffSummary } from '../lib/paragraphs.js'
import { DEFAULT_RULES, normRules, validateRules, maskParas, maskLineText } from '../lib/draftMask.js'
import { DAY_BASES, ANCHORS, computeDueDate, daysLeft, basisHint } from '../lib/deadlineCalc.js'
import { getCalendar } from './holidayService.js'
import { resolveStart } from './docService.js'
import { nowIso, tzToday } from '../lib/dates.js'
import { config } from '../config.js'
import { getStorage, buildObjectKey, sha256Of } from './storage/index.js'
import { bumpDash } from './dashboardService.js'

const VERSION_OK = '有效'
const VERSION_VOID = '已作废'

// ---------------- 脱敏规则 ----------------

export async function listMaskRules() {
  const rows = await query('SELECT id, version, rules_json, is_active, note, created_at FROM mask_rules ORDER BY version DESC')
  return rows.map((r) => ({ ...r, rules: JSON.parse(r.rules_json), is_active: Boolean(r.is_active) }))
}

export async function getActiveRules() {
  const rows = await query('SELECT * FROM mask_rules WHERE is_active = 1 ORDER BY version DESC LIMIT 1')
  if (rows.length) return { version: rows[0].version, rules: normRules(JSON.parse(rows[0].rules_json)) }
  return { version: 0, rules: normRules(DEFAULT_RULES) }
}

export async function updateMaskRules(user, { rules, note = '' } = {}) {
  const v = validateRules(rules)
  if (!v.ok) throw new ApiError(400, 'BAD_RULES', v.error)
  const rows = await query('SELECT COALESCE(MAX(version),0) AS m FROM mask_rules')
  const nextVersion = Number(rows[0].m) + 1
  await tx(async (d) => {
    await d.query('UPDATE mask_rules SET is_active = 0')
    await d.insert(
      'INSERT INTO mask_rules (version, rules_json, is_active, note, created_by, created_at) VALUES (?,?,?,?,?,?)',
      [nextVersion, JSON.stringify(normRules(rules)), 1, String(note).slice(0, 300), user.id, nowIso()]
    )
  })
  return getActiveRules()
}

// ---------------- 读取 ----------------

async function loadCaseRow(user, caseId) {
  const rows = await query('SELECT * FROM cases WHERE id = ?', [caseId])
  if (!rows.length) throw new ApiError(404, 'NOT_FOUND', '案件不存在')
  assertClientAccess(user, rows[0].client_id)
  return rows[0]
}

function canFirm(user) {
  return ['admin', 'agent', 'reviewer'].includes(user.role)
}

function assertDtype(dtype) {
  const def = draftTypeDef(dtype)
  if (!def) throw new ApiError(400, 'BAD_REQUEST', `未知文书类型「${dtype}」`)
  return def
}

async function getDraftRow(caseId, dtype, { required = false } = {}) {
  const rows = await query('SELECT * FROM drafts WHERE case_id = ? AND dtype = ?', [caseId, dtype])
  if (!rows.length && required) throw new ApiError(404, 'NOT_FOUND', '还没有该文书的草稿')
  return rows[0] || null
}

async function getVersionRow(versionId) {
  const rows = await query('SELECT * FROM draft_versions WHERE id = ?', [versionId])
  if (!rows.length) throw new ApiError(404, 'NOT_FOUND', '版本不存在')
  return rows[0]
}

// 单版本对外视图：所内看原文（含 secret/citation 标记），客户看生成时固化的脱敏快照
function presentVersion(v, user) {
  const firm = canFirm(user)
  const base = {
    id: v.id,
    version_no: v.version_no,
    parent_id: v.parent_id,
    merged_from_id: v.merged_from_id,
    status: v.status,
    author_id: v.author_id,
    author_name: v.author_name,
    author_role: v.author_role,
    summary: v.summary,
    mask_rule_version: v.mask_rule_version,
    attachment_file_id: v.attachment_file_id,
    merge_resolutions: JSON.parse(v.merge_resolutions_json || '[]'),
    created_at: v.created_at,
    voided_at: v.voided_at,
    void_reason: v.void_reason,
  }
  if (firm) {
    const paras = JSON.parse(v.paras_json)
    return { ...base, masked: false, paras, content: v.content }
  }
  const maskedParas = JSON.parse(v.masked_paras_json)
  return { ...base, masked: true, paras: maskedParas, content: parasToContent(maskedParas) }
}

async function presentAttachment(att) {
  const files = await query('SELECT * FROM draft_attachment_files WHERE attachment_id = ? ORDER BY version_no DESC', [att.id])
  const current = files.find((f) => f.id === att.current_file_id) || files[0] || null
  const presentFile = (f) => ({
    id: f.id,
    version_no: f.version_no,
    original_name: f.original_name,
    size: f.size,
    content_type: f.content_type,
    parse_status: f.parse_status,
    parse_note: f.parse_note,
    created_at: f.created_at,
    parsed_at: f.parsed_at,
  })
  return {
    id: att.id,
    label: att.label,
    status: att.status,
    current_file_id: att.current_file_id,
    current: current ? presentFile(current) : null,
    files: files.map(presentFile),
  }
}

async function deadlineView(deadlineId) {
  if (!deadlineId) return null
  const rows = await query('SELECT * FROM deadlines WHERE id = ?', [deadlineId])
  if (!rows.length) return null
  const d = rows[0]
  const t = tzToday(config.firmTz)
  return {
    id: d.id,
    dtype: d.dtype,
    anchor_basis: d.anchor_basis,
    day_basis: d.day_basis,
    basis_hint: basisHint(d.day_basis),
    start_date: d.start_date,
    duration_days: d.duration_days,
    due_date: d.due_date,
    rolled: Boolean(d.rolled),
    status: d.status,
    days_left: d.status === '待处理' ? daysLeft(d.due_date, t) : null,
    overdue_reason: d.overdue_reason,
  }
}

async function attachmentsState(draftId) {
  const attRows = await query('SELECT * FROM draft_attachments WHERE draft_id = ?', [draftId])
  const list = await Promise.all(attRows.map(presentAttachment))
  const parsing = list.some((a) => a.current?.parse_status === '解析中' || a.status === '解析中')
  return { list, parsing }
}

// 空态口径（三种各给不同界面，不许一个「暂无数据」打发）：
//   no_draft 还没有任何草稿；all_void 草稿全部作废；attachment_parsing 原件还在解析（尚无有效版本）
function emptyStateFor({ versionCount, validCount, parsing }) {
  if (validCount > 0) return null
  if (parsing) return 'attachment_parsing'
  if (versionCount > 0) return 'all_void'
  return 'no_draft'
}

export async function listDrafts(user, caseId) {
  await loadCaseRow(user, caseId)
  const rows = await query('SELECT * FROM drafts WHERE case_id = ?', [caseId])
  const byType = new Map(rows.map((r) => [r.dtype, r]))
  const out = []
  for (const def of [draftTypeDef('technical_disclosure'), draftTypeDef('claims'), draftTypeDef('specification')]) {
    const row = byType.get(def.key)
    if (!row) {
      out.push({ case_id: caseId, dtype: def.key, label: def.label, exists: false, status: '无草稿', empty_state: 'no_draft', client_editable: def.clientEditable && !canFirm(user) })
      continue
    }
    const versions = await query('SELECT * FROM draft_versions WHERE draft_id = ? ORDER BY version_no', [row.id])
    const valid = versions.filter((v) => v.status === VERSION_OK)
    const { parsing } = await attachmentsState(row.id)
    out.push({
      case_id: caseId,
      draft_id: row.id,
      dtype: def.key,
      label: def.label,
      exists: true,
      status: valid.length === 0 ? '无有效版本' : row.status,
      empty_state: emptyStateFor({ versionCount: versions.length, validCount: valid.length, parsing }),
      parsing_attachment: parsing,
      version_count: versions.length,
      valid_count: valid.length,
      current_version_id: row.current_version_id,
      final_version_id: row.final_version_id,
      has_deadline: Boolean(row.deadline_id),
      client_editable: def.clientEditable && !canFirm(user),
      client_readable: def.clientReadable,
      latest_at: versions.at(-1)?.created_at || row.updated_at,
    })
  }
  return out
}

export async function getDraft(user, caseId, dtype) {
  await loadCaseRow(user, caseId)
  const def = assertDtype(dtype)
  const draft = await getDraftRow(caseId, dtype)
  if (!draft) return { case_id: caseId, dtype, label: def.label, exists: false, status: '无草稿', empty_state: 'no_draft', client_editable: def.clientEditable && !canFirm(user) }
  const versionRows = await query('SELECT * FROM draft_versions WHERE draft_id = ? ORDER BY version_no', [draft.id])
  const validCount = versionRows.filter((v) => v.status === VERSION_OK).length
  const { list: attachments, parsing } = await attachmentsState(draft.id)
  const current = draft.current_version_id ? versionRows.find((v) => v.id === draft.current_version_id) || null : null
  const activeRules = await getActiveRules()
  return {
    case_id: caseId,
    draft_id: draft.id,
    dtype,
    label: def.label,
    exists: true,
    status: current ? draft.status : '无有效版本',
    empty_state: emptyStateFor({ versionCount: versionRows.length, validCount, parsing }),
    parsing_attachment: parsing,
    finalized: draft.status === '已定稿',
    finalized_at: draft.finalized_at,
    current_version: current ? presentVersion(current, user) : null,
    versions: versionRows.map((v) => presentVersion(v, user)),
    attachments,
    deadline: await deadlineView(draft.deadline_id),
    client_editable: def.clientEditable && !canFirm(user),
    viewer: { role: user.role, name: user.name, firm: canFirm(user) },
    active_mask_rule_version: activeRules.version,
  }
}

// ---------------- 保存（三路合并 + 冲突） ----------------

function assignKeys(paras) {
  return paras.map((p) => (p.key ? p : { ...p, key: crypto.randomUUID() }))
}

// 客户看到的是脱敏版：回存时必须按其所基于版本的脱敏快照对账——
// 段落只要脱敏后与原文不一致（整段遮蔽，或含行内掩码），客户看到的就不是真文本，无权编辑，一律恢复原文；
// 其余未改动段落也恢复原文（不把界面占位写回）；客户确实改写的明文段落与新增段落保留；tags 客户不能改。
function reconcileClientParas(mine, baseParas, baseMaskedParas) {
  const orig = new Map(baseParas.map((p) => [p.key, p]))
  const shown = new Map(baseMaskedParas.map((p) => [p.key, p]))
  return mine.map((p) => {
    const o = orig.get(p.key)
    if (!o) return { ...p, tags: [] } // 客户新增段
    const s = shown.get(p.key)
    if (s?.masked_tag || s?.masked) return { key: p.key, text: o.text, tags: o.tags } // 含敏感内容：客户侧锁定
    if (s && normText(s.text) === normText(p.text)) return { key: p.key, text: o.text, tags: o.tags } // 未改动 → 原文
    return { key: p.key, text: p.text, tags: o.tags } // 明文段落被客户改写
  })
}

function skeletonPositions(theirsParas, mineParas) {
  const order = []
  for (const p of theirsParas) if (!order.includes(p.key)) order.push(p.key)
  for (const p of mineParas) if (!order.includes(p.key)) order.push(p.key)
  return new Map(order.map((k, i) => [k, i]))
}

function conflictDetail(cf, { firm, rules }) {
  // 客户视角的纵深防护：标签不外带，文本再过一遍当前行内脱敏（正常路径下能冲突的只会是明文段）。
  const brief = (p) => (p
    ? { text: firm ? p.text : maskLineText(p.text, rules), tags: firm ? p.tags : [] }
    : null)
  return { key: cf.key, reason: cf.reason, base: brief(cf.base), mine: brief(cf.mine), theirs: brief(cf.theirs) }
}

export async function saveVersion(user, caseId, dtype, body = {}) {
  const c = await loadCaseRow(user, caseId)
  const def = assertDtype(dtype)
  const firm = canFirm(user)
  if (!firm && !def.clientEditable) throw new ApiError(403, 'ROLE_DENIED', '该文书仅代理人侧可编辑，您可查看脱敏版。')

  let mine = normalizeParas(body.paras)
  if (!mine.length && !String(body.content || '').trim()) {
    throw new ApiError(400, 'BAD_REQUEST', '内容为空：请填写段落或正文后再保存。')
  }
  if (!mine.length) mine = normalizeParas(String(body.content).split(/\n\s*\n/))
  mine = assignKeys(mine)

  const summary = String(body.summary || '').slice(0, 300)
  const resolutions = Array.isArray(body.resolutions) ? body.resolutions : []
  const now = nowIso()
  const active = await getActiveRules()

  const result = await tx(async (d) => {
    let draft = (await d.query('SELECT * FROM drafts WHERE case_id = ? AND dtype = ?', [caseId, dtype]))[0] || null
    if (!draft) {
      if (body.parent_id) throw new ApiError(400, 'BAD_REQUEST', '该文书尚无版本，不能携带 parent_id。')
      const draftId = await d.insert(
        'INSERT INTO drafts (case_id, dtype, status, created_at, updated_at) VALUES (?,?,?,?,?)',
        [caseId, dtype, '编辑中', now, now]
      )
      draft = { id: draftId, status: '编辑中', current_version_id: null, final_version_id: null }
    }
    if (draft.status === '已定稿') throw new ApiError(409, 'DRAFT_FINALIZED', '该文书已定稿，内容不可再改；如需修订请走新一轮定稿流程。')

    const versions = await d.query('SELECT * FROM draft_versions WHERE draft_id = ? ORDER BY version_no', [draft.id])
    const maxNo = versions.reduce((m, v) => Math.max(m, v.version_no), 0)
    const current = draft.current_version_id ? versions.find((v) => v.id === draft.current_version_id) || null : null

    let base = null
    if (body.parent_id) {
      base = versions.find((v) => v.id === Number(body.parent_id))
      if (!base) throw new ApiError(400, 'PARENT_NOT_FOUND', '所基于的父版本不属于该文书，请刷新后重试。')
    } else if (current) {
      throw new ApiError(400, 'PARENT_REQUIRED', '该文书已有版本：保存时必须携带所基于的 parent_id（请基于最新版本编辑）。')
    }
    if (!firm) {
      mine = reconcileClientParas(
        mine,
        base ? JSON.parse(base.paras_json) : [],
        base ? JSON.parse(base.masked_paras_json) : []
      )
    }

    const theirsParas = current ? JSON.parse(current.paras_json) : []
    const baseParas = base ? JSON.parse(base.paras_json) : []
    const merged = mergeParas(baseParas, mine, theirsParas)
    const concurrent = Boolean(current && base && current.id !== base.id)

    let finalParas = merged.paras
    let usedResolutions = []
    if (merged.conflicts.length) {
      const { resolved, unresolved } = resolveConflicts(merged, resolutions)
      if (unresolved.length || resolved.length !== merged.conflicts.length) {
        // 不产生任何版本：把段落级冲突原样带回，交取舍界面逐段处理
        throw new ApiError(409, 'PARAGRAPH_CONFLICT', '有段落被双方同时修改，请逐段取舍后再保存（你的内容不会被静默覆盖）。', {
          dtype,
          draft_id: draft.id,
          parent_id: base?.id || null,
          current_version_id: current?.id || null,
          current_version_no: current?.version_no || null,
          conflicts: merged.conflicts.map((cf) => conflictDetail(cf, { firm, rules: active.rules })),
        })
      }
      usedResolutions = resolved
      // 按骨架位置把裁决后的段落插回原位；裁决为接受删除的段落不插回
      const pos = skeletonPositions(theirsParas, mine)
      const chosenByKey = new Map(resolved.filter((r) => !r.drop).map((r) => [r.key, { key: r.key, text: r.text, tags: r.tags }]))
      for (const cf of merged.conflicts) {
        const p = chosenByKey.get(cf.key)
        if (p) finalParas.push(p)
      }
      finalParas.sort((a, b) => (pos.get(a.key) ?? 1e9) - (pos.get(b.key) ?? 1e9))
    }

    if (!finalParas.length) throw new ApiError(400, 'BAD_REQUEST', '合并后没有任何有效段落（双方删除且无新增），未生成版本。')

    const masked = maskParas(finalParas, active.rules)
    const attRows = await d.query('SELECT current_file_id FROM draft_attachments WHERE draft_id = ?', [draft.id])
    const attachmentFileId = attRows.map((r) => r.current_file_id).find(Boolean) || null

    const content = parasToContent(finalParas)
    const newId = await d.insert(
      `INSERT INTO draft_versions
       (draft_id, version_no, parent_id, merged_from_id, content, paras_json, masked_paras_json, mask_rule_version,
        status, author_id, author_name, author_role, summary, attachment_file_id, merge_resolutions_json, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [draft.id, maxNo + 1, base?.id || null, concurrent ? current.id : null,
       content, JSON.stringify(finalParas), JSON.stringify(masked.paras), active.version,
       VERSION_OK, user.id, user.name, user.role, summary, attachmentFileId,
       JSON.stringify(usedResolutions.map((r) => ({ key: r.key, pick: r.pick, at: now, by: user.name }))), now]
    )
    await d.query('UPDATE drafts SET current_version_id = ?, updated_at = ? WHERE id = ?', [newId, now, draft.id])
    return {
      draftId: draft.id, versionId: newId, versionNo: maxNo + 1,
      hadConflicts: merged.conflicts.length > 0,
      stats: { ...diffSummary(diffParas(baseParas, finalParas)), conflicts_resolved: merged.conflicts.length },
      mask_stats: masked.stats,
      concurrent,
    }
  })

  const fresh = await getDraft(user, caseId, dtype)
  return { ...result, draft: fresh }
}

// ---------------- 作废 / 重开 ----------------

export async function voidVersion(user, caseId, dtype, versionId, { reason } = {}) {
  await loadCaseRow(user, caseId)
  assertDtype(dtype)
  if (!canFirm(user)) throw new ApiError(403, 'ROLE_DENIED', '仅代理人侧可作废旧版本')
  if (!reason || String(reason).trim().length < 2) throw new ApiError(400, 'REASON_REQUIRED', '作废必须填写不少于 2 字的原因并留痕。')
  const draft = await getDraftRow(caseId, dtype, { required: true })
  if (draft.status === '已定稿') throw new ApiError(409, 'DRAFT_FINALIZED', '该文书已定稿，不能作废其版本。')
  await tx(async (d) => {
    const v = (await d.query('SELECT * FROM draft_versions WHERE id = ? AND draft_id = ?', [versionId, draft.id]))[0]
    if (!v) throw new ApiError(404, 'NOT_FOUND', '版本不存在')
    if (v.status !== VERSION_OK) throw new ApiError(409, 'VERSION_VOID', '该版本此前已作废，无需重复操作。')
    await d.query('UPDATE draft_versions SET status = ?, voided_at = ?, void_reason = ? WHERE id = ?',
      [VERSION_VOID, nowIso(), String(reason).trim().slice(0, 300), v.id])
    const rest = await d.query('SELECT id FROM draft_versions WHERE draft_id = ? AND status = ? ORDER BY version_no DESC LIMIT 1',
      [draft.id, VERSION_OK])
    await d.query('UPDATE drafts SET current_version_id = ?, updated_at = ? WHERE id = ?',
      [rest[0]?.id || null, nowIso(), draft.id])
  })
  return getDraft(user, caseId, dtype)
}

// 从任一历史版本（含已作废版本）重开：复制其段落另起新版本，链不断、旧版本原样保留
export async function reopenFromVersion(user, caseId, dtype, { from_version_id, summary = '' } = {}) {
  const c = await loadCaseRow(user, caseId)
  const def = assertDtype(dtype)
  if (!canFirm(user) && !def.clientEditable) throw new ApiError(403, 'ROLE_DENIED', '该文书客户侧不可编辑')
  if (!from_version_id) throw new ApiError(400, 'BAD_REQUEST', '请选择要基于哪个历史版本重开。')
  const draft = await getDraftRow(c.id, dtype, { required: true })
  if (draft.status === '已定稿') throw new ApiError(409, 'DRAFT_FINALIZED', '该文书已定稿，不能重开草稿。')
  const active = await getActiveRules()
  const now = nowIso()
  await tx(async (d) => {
    const versions = await d.query('SELECT * FROM draft_versions WHERE draft_id = ? ORDER BY version_no', [draft.id])
    const src = versions.find((v) => v.id === Number(from_version_id))
    if (!src) throw new ApiError(404, 'NOT_FOUND', '所选择的历史版本不属于该文书。')
    const paras = JSON.parse(src.paras_json) // 沿用原段落 key，保证与历史版本 diff 可对齐
    const maxNo = versions.reduce((m, v) => Math.max(m, v.version_no), 0)
    const masked = maskParas(paras, active.rules)
    const attRows = await d.query('SELECT current_file_id FROM draft_attachments WHERE draft_id = ?', [draft.id])
    const attachmentFileId = attRows.map((r) => r.current_file_id).find(Boolean) || null
    const newId = await d.insert(
      `INSERT INTO draft_versions
       (draft_id, version_no, parent_id, merged_from_id, content, paras_json, masked_paras_json, mask_rule_version,
        status, author_id, author_name, author_role, summary, attachment_file_id, merge_resolutions_json, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [draft.id, maxNo + 1, src.id, null, parasToContent(paras), JSON.stringify(paras), JSON.stringify(masked.paras),
       active.version, VERSION_OK, user.id, user.name, user.role,
       String(summary || `基于 v${src.version_no} 重开`).slice(0, 300), attachmentFileId, '[]', now]
    )
    await d.query('UPDATE drafts SET current_version_id = ?, updated_at = ? WHERE id = ?', [newId, now, draft.id])
  })
  return getDraft(user, caseId, dtype)
}

// ---------------- 定稿 + 期限联动（沿用官文口径） ----------------

async function resolveFinalizeDates(body) {
  if (body.source_doc_id) {
    const rows = await query('SELECT dispatch_date, receive_date FROM official_docs WHERE id = ? AND status <> ?',
      [Number(body.source_doc_id), '已撤回'])
    if (!rows.length) throw new ApiError(400, 'BAD_REQUEST', '所选官文不存在或已撤回。')
    return { dispatch_date: rows[0].dispatch_date, receive_date: rows[0].receive_date, source_doc_id: Number(body.source_doc_id) }
  }
  return {
    dispatch_date: body.dispatch_date || null,
    receive_date: body.receive_date || null,
    source_doc_id: null,
  }
}

// 定稿期限到期日预览（与官文登记共用 resolveStart / computeDueDate）
export async function previewFinalize(user, caseId, dtype, body = {}) {
  await loadCaseRow(user, caseId)
  const def = assertDtype(dtype)
  const anchor = body.anchor || FINALIZE_DEADLINE_DEFAULTS.anchor
  const day_basis = body.day_basis || FINALIZE_DEADLINE_DEFAULTS.dayBasis
  const n = Math.trunc(Number(body.duration_days ?? FINALIZE_DEADLINE_DEFAULTS.days))
  if (!ANCHORS.includes(anchor)) throw new ApiError(400, 'BAD_REQUEST', '起算口径只能是 receive / dispatch')
  if (!DAY_BASES.includes(day_basis)) throw new ApiError(400, 'BAD_REQUEST', '天数口径只能是 natural / workday / legal')
  if (!Number.isFinite(n) || n <= 0) throw new ApiError(400, 'BAD_REQUEST', '期限天数必须为正整数')
  const dates = await resolveFinalizeDates(body)
  const resolved = resolveStart({ anchor, dispatch_date: dates.dispatch_date, receive_date: dates.receive_date })
  if (resolved.error) throw new ApiError(400, 'BAD_REQUEST', resolved.error)
  const cal = await getCalendar()
  const r = computeDueDate({ start_date: resolved.start_date, duration_days: n, day_basis }, cal)
  const t = tzToday(config.firmTz)
  const left = daysLeft(r.due_date, t)
  return {
    label: def.deadlineLabel,
    anchor, anchor_hint: anchor === 'receive' ? '以收到日为准起算（无实际收到日时按发文日+15日推定）' : '以发文日为准起算',
    day_basis, basis_hint: basisHint(day_basis),
    duration_days: n, start_date: resolved.start_date, start_kind: resolved.start_kind,
    due_date: r.due_date, rolled: r.rolled, days_left: left, overdue: left < 0,
    server_today: t, firm_tz: config.firmTz,
  }
}

export async function finalize(user, caseId, dtype, body = {}) {
  await loadCaseRow(user, caseId)
  const def = assertDtype(dtype)
  if (!canFirm(user)) throw new ApiError(403, 'ROLE_DENIED', '仅代理人侧可定稿')
  const draft = await getDraftRow(caseId, dtype, { required: true })
  if (draft.status === '已定稿') {
    return { noop: true, draft: await getDraft(user, caseId, dtype) }
  }
  const current = draft.current_version_id
    ? (await query('SELECT * FROM draft_versions WHERE id = ?', [draft.current_version_id]))[0]
    : null
  if (!current) throw new ApiError(409, 'NO_VALID_VERSION', '没有有效版本可定稿（草稿可能已全部作废），请从历史版本重开后再定稿。')

  let deadlineId = null
  let preview = null
  let dates = null
  if (body.create_deadline !== false) {
    preview = await previewFinalize(user, caseId, dtype, body)
    if (preview.days_left < 0 && !body.confirm_overdue) {
      throw new ApiError(409, 'OVERDUE_CONFIRM',
        `按所选口径该定稿提交期限到期日为 ${preview.due_date}，截至代理所今日（${preview.server_today}）已逾期 ${-preview.days_left} 天。请确认并填写超期原因后再定稿。`,
        { preview })
    }
    if (preview.days_left < 0 && (!body.overdue_reason || String(body.overdue_reason).trim().length < 2)) {
      throw new ApiError(400, 'OVERDUE_REASON_REQUIRED', '落点已逾期：必须填写超期原因（不少于 2 字）留痕。', { preview })
    }
    dates = await resolveFinalizeDates(body)
  }

  const now = nowIso()
  await tx(async (d) => {
    if (dates) {
      deadlineId = await d.insert(
        `INSERT INTO deadlines (case_id, doc_id, dtype, anchor_basis, day_basis, start_date, duration_days, due_date, rolled, status, note, overdue_reason, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [caseId, dates.source_doc_id, def.deadlineLabel, preview.anchor, preview.day_basis, preview.start_date,
         preview.duration_days, preview.due_date, preview.rolled ? 1 : 0, '待处理',
         `随《${def.label}》定稿生成`, preview.days_left < 0 ? String(body.overdue_reason).trim() : '', now]
      )
    }
    await d.query('UPDATE drafts SET status = ?, final_version_id = ?, deadline_id = COALESCE(?, deadline_id), finalized_at = ?, updated_at = ? WHERE id = ?',
      ['已定稿', current.id, deadlineId, now, now, draft.id])
  })
  if (deadlineId) await bumpDash()
  return { noop: false, final_version_id: current.id, deadline_id: deadlineId, deadline_preview: preview, draft: await getDraft(user, caseId, dtype) }
}

// ---------------- 差异 ----------------

export async function getDiff(user, caseId, dtype, fromId, toId) {
  await loadCaseRow(user, caseId)
  assertDtype(dtype)
  const firm = canFirm(user)
  const [fromV, toV] = await Promise.all([getVersionRow(fromId), getVersionRow(toId)])
  const draft = await getDraftRow(caseId, dtype, { required: true })
  if (fromV.draft_id !== draft.id || toV.draft_id !== draft.id) throw new ApiError(400, 'BAD_REQUEST', '两个版本不属于同一文书。')
  const pick = (v) => (firm ? JSON.parse(v.paras_json) : JSON.parse(v.masked_paras_json))
  const diff = diffParas(pick(fromV), pick(toV))
  return {
    masked: !firm,
    from: { id: fromV.id, version_no: fromV.version_no, created_at: fromV.created_at },
    to: { id: toV.id, version_no: toV.version_no, created_at: toV.created_at },
    summary: diffSummary(diff),
    diff,
  }
}

// ---------------- 附件（对象存储，元数据入库，换版不可变） ----------------

const MAX_UPLOAD = 20 * 1024 * 1024

export async function uploadAttachment(user, caseId, dtype, buffer, { filename, contentType } = {}) {
  await loadCaseRow(user, caseId)
  const def = assertDtype(dtype)
  const firm = canFirm(user)
  if (!firm && !def.clientEditable) throw new ApiError(403, 'ROLE_DENIED', '该文书仅代理人侧可上传附件。')
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new ApiError(400, 'EMPTY_FILE', '附件内容为空。')
  if (buffer.length > MAX_UPLOAD) throw new ApiError(400, 'FILE_TOO_LARGE', '附件不能超过 20MB（原件请走对象存储分传）。')
  const originalName = String(filename || '附件原件').slice(0, 255)
  const now = nowIso()
  const storage = await getStorage()

  let attachmentId, fileId, versionNo
  await tx(async (d) => {
    let draft = (await d.query('SELECT * FROM drafts WHERE case_id = ? AND dtype = ?', [caseId, dtype]))[0] || null
    if (!draft) {
      const id = await d.insert('INSERT INTO drafts (case_id, dtype, status, created_at, updated_at) VALUES (?,?,?,?,?)',
        [caseId, dtype, '编辑中', now, now])
      draft = { id }
    }
    let att = (await d.query('SELECT * FROM draft_attachments WHERE draft_id = ? ORDER BY id LIMIT 1', [draft.id]))[0] || null
    if (!att) {
      attachmentId = await d.insert(
        'INSERT INTO draft_attachments (draft_id, case_id, label, status, created_by, created_at) VALUES (?,?,?,?,?,?)',
        [draft.id, caseId, '原件', '解析中', user.id, now]
      )
      att = { id: attachmentId }
    } else {
      attachmentId = att.id
    }
    const files = await d.query('SELECT COALESCE(MAX(version_no),0) AS m FROM draft_attachment_files WHERE attachment_id = ?', [attachmentId])
    versionNo = Number(files[0].m) + 1
    const sha = sha256Of(buffer)
    // 先落库（解析中），拿到自增 id 才能构造对象 key
    fileId = await d.insert(
      `INSERT INTO draft_attachment_files
       (attachment_id, version_no, object_key, bucket, driver, original_name, size, content_type, sha256, parse_status, uploaded_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [attachmentId, versionNo, '', storage.bucket, storage.name, originalName, buffer.length,
       String(contentType || 'application/octet-stream'), sha, '解析中', user.id, now]
    )
    const key = buildObjectKey({ caseId, dtype, attachmentId, versionNo, filename: originalName, sha256: sha })
    await d.query('UPDATE draft_attachment_files SET object_key = ? WHERE id = ?', [key, fileId])
    await d.query('UPDATE draft_attachments SET status = ?, current_file_id = ? WHERE id = ?', ['解析中', fileId, attachmentId])
    // 对象本体在此事务外上传（见下）；key 已持久化，上传失败可按 key 重传
    return key
  })

  const fileRow = (await query('SELECT * FROM draft_attachment_files WHERE id = ?', [fileId]))[0]
  try {
    await storage.put(fileRow.object_key, buffer, { contentType: fileRow.content_type })
  } catch (e) {
    await query("UPDATE draft_attachment_files SET parse_status = '解析失败', parse_note = ? WHERE id = ?",
      [`对象存储上传失败：${String(e.message).slice(0, 200)}`, fileId])
    throw new ApiError(502, 'STORAGE_ERROR', `附件已登记但对象存储上传失败：${e.message}`)
  }
  scheduleParse(fileId, originalName, buffer.length)
  return getDraft(user, caseId, dtype)
}

// 模拟原件解析（真实环境换为异步 OCR/版式解析 worker）：标记就绪并回填页数摘要
function scheduleParse(fileId, filename, size) {
  const fail = /(损坏| corrupt|\.fail$)/i.test(filename)
  setTimeout(() => {
    ;(async () => {
      const pages = Math.max(1, Math.round(size / 40000))
      await query(
        "UPDATE draft_attachment_files SET parse_status = ?, parse_note = ?, parsed_at = ? WHERE id = ? AND parse_status = '解析中'",
        fail
          ? ['解析失败', '原件无法解析：文件可能已损坏或格式不受支持，请重新上传换版。', nowIso(), fileId]
          : ['就绪', `原件解析完成：约 ${pages} 页，已建立全文索引。`, nowIso(), fileId]
      )
      const f = (await query('SELECT attachment_id, parse_status FROM draft_attachment_files WHERE id = ?', [fileId]))[0]
      if (f) {
        await query('UPDATE draft_attachments SET status = ? WHERE id = ?',
          [f.parse_status === '就绪' ? '就绪' : '解析失败', f.attachment_id])
      }
    })().catch(() => {})
  }, 1200)
}

// 版本指向的附件文件（旧版本永远拿到当时的旧对象）
export async function downloadVersionAttachment(user, versionId) {
  const v = await getVersionRow(versionId)
  if (!v.attachment_file_id) throw new ApiError(404, 'NO_ATTACHMENT', '该版本生成时还没有挂附件原件。')
  const rows = await query(
    `SELECT f.*, d.case_id, dr.dtype FROM draft_attachment_files f
     JOIN draft_attachments d ON d.id = f.attachment_id JOIN drafts dr ON dr.id = d.draft_id
     WHERE f.id = ?`, [v.attachment_file_id])
  if (!rows.length) throw new ApiError(404, 'NOT_FOUND', '附件文件不存在')
  const c = await loadCaseRow(user, rows[0].case_id)
  return fetchFile(rows[0])
}

export async function downloadCurrentAttachment(user, attachmentId) {
  const rows = await query(
    `SELECT f.*, d.case_id FROM draft_attachments d
     JOIN draft_attachment_files f ON f.id = d.current_file_id WHERE d.id = ?`, [attachmentId])
  if (!rows.length) throw new ApiError(404, 'NO_ATTACHMENT', '附件尚无已上传的文件版本。')
  await loadCaseRow(user, rows[0].case_id)
  return fetchFile(rows[0])
}

async function fetchFile(fileRow) {
  const storage = await getStorage()
  const obj = await storage.get(fileRow.object_key)
  return {
    buffer: obj.body,
    headers: {
      'Content-Type': fileRow.content_type || 'application/octet-stream',
      'Content-Length': String(fileRow.size),
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fileRow.original_name || 'attachment')}`,
      'X-File-Version': String(fileRow.version_no),
    },
  }
}
