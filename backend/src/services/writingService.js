import { query, tx } from '../db.js'
import { ApiError } from '../middleware/error.js'
import { assertClientAccess } from '../middleware/auth.js'
import { isFirmRole } from '../lib/mask.js'
import { docKindDef, normalizeContent, contentEqual, contentParagraphCount, DOC_STATUS } from '../lib/writing.js'
import { DEFAULT_RULES, maskContent, maskParagraphText, compilePatterns, reconcileClientContent, restorePlaceholders } from '../lib/docMask.js'
import { diffContent, threeWayMerge } from '../lib/paragraphs.js'
import { computeDueDate, daysLeft, ANCHORS, DAY_BASES } from '../lib/deadlineCalc.js'
import { getCalendar } from './holidayService.js'
import { nowIso, tzToday, addDays } from '../lib/dates.js'
import { config } from '../config.js'
import { buildObjectKey, grantUpload, consumeUploadGrant, putObject, getObject } from './objectStore.js'
import { bumpDash } from './dashboardService.js'

// ============ 基础读取 ============

async function loadCase(user, caseId) {
  const rows = await query('SELECT * FROM cases WHERE id = ?', [caseId])
  if (!rows.length) throw new ApiError(404, 'NOT_FOUND', '案件不存在')
  assertClientAccess(user, rows[0].client_id)
  return rows[0]
}

const firm = (user) => isFirmRole(user.role)

// 三类文档的写权限：交底书客户与代理人协同；权利要求/说明书是代理工作产品，仅所内。
function assertCanWrite(user, kind) {
  if (firm(user)) return
  if (user.role === 'client_admin' && kind === 'disclosure') return
  throw new ApiError(403, 'ROLE_DENIED', '权利要求草稿与说明书定稿仅代理人侧可编辑，客户侧可查看脱敏版。')
}

function assertCanRead(user, _kind) {
  // 客户管理员经 loadCase 的租户校验后可读（脱敏）；所内读原文
  if (!firm(user) && user.role !== 'client_admin') throw new ApiError(403, 'ROLE_DENIED', '无权查看撰稿文档')
}

async function activeRules() {
  const rows = await query('SELECT * FROM mask_rules WHERE is_active = 1 ORDER BY version DESC LIMIT 1')
  if (!rows.length) return { version: 0, rules: { version: 0, ...DEFAULT_RULES } }
  return { id: rows[0].id, version: rows[0].version, rules: { version: rows[0].version, ...JSON.parse(rows[0].rules_json) } }
}

async function getDocById(docId) {
  const rows = await query('SELECT * FROM writing_docs WHERE id = ?', [docId])
  if (!rows.length) throw new ApiError(404, 'NOT_FOUND', '撰稿文档不存在')
  return rows[0]
}

async function getVersionById(versionId) {
  const rows = await query('SELECT * FROM writing_versions WHERE id = ?', [versionId])
  if (!rows.length) throw new ApiError(404, 'NOT_FOUND', '版本不存在')
  return rows[0]
}

function parseVersion(v) {
  return {
    ...v,
    content: JSON.parse(v.content_json),
    mask_snapshot: JSON.parse(v.mask_snapshot_json),
  }
}

// ============ 版本展示（客户脱敏 / 代理原文，同一版本行）============

function presentVersion(v, viewer, { branchVersionNo = null } = {}) {
  const pv = parseVersion(v)
  const base = {
    id: pv.id,
    version_no: pv.version_no,
    save_type: pv.save_type,
    summary: pv.summary,
    base_version_id: pv.base_version_id,
    parent_version_id: pv.parent_version_id,
    branch_from_version_id: pv.branch_from_version_id,
    branch_from_version_no: branchVersionNo,
    actor_id: pv.actor_id,
    actor_name: pv.actor_name,
    actor_role: pv.actor_role,
    created_at: pv.created_at,
    mask_rule_version: pv.mask_snapshot.version ?? null,
  }
  if (firm(viewer)) {
    return { ...base, content: pv.content, masked: false, masked_paragraphs: 0 }
  }
  const masked = maskContent(pv.content, pv.mask_snapshot)
  return { ...base, content: masked, masked: true, masked_paragraphs: masked.masked_paragraphs }
}

// ============ 案件撰稿总览（决定三种空态）============

export async function listCaseWriting(user, caseId) {
  const c = await loadCase(user, caseId)
  const rows = await query('SELECT * FROM writing_docs WHERE case_id = ? ORDER BY id DESC', [caseId])
  const kinds = {}
  for (const def of [ 'disclosure', 'claims', 'specification' ]) {
    const mine = rows.filter((r) => r.doc_kind === def)
    const active = mine.find((r) => r.status !== DOC_STATUS.VOID)
    let state = 'none'
    if (active) {
      // 已建链但还没有任何文字版本：若已有原件上传且仍在解析 → 独立的「附件还在解析」空态
      if (active.current_version === 0) {
        const parsing = await query(
          `SELECT COUNT(*) AS n FROM writing_attachment_versions v
           JOIN writing_attachments a ON a.id = v.attachment_id
           WHERE a.doc_id = ? AND v.status = '解析中'`,
          [active.id]
        )
        state = Number(parsing[0].n) > 0 ? 'parsing' : 'active'
      } else state = 'active'
    } else if (mine.length) state = 'void'
    kinds[def] = {
      state,
      doc: active ? briefDoc(active) : null,
      voided_count: mine.filter((r) => r.status === DOC_STATUS.VOID).length,
      // 作废链仍列出来：空态里可以展开任一作废稿，回到其历史版本重开
      voided_docs: mine.filter((r) => r.status === DOC_STATUS.VOID).map(briefDoc),
    }
  }
  const rules = await activeRules()
  return {
    case_id: Number(caseId),
    case_no: c.case_no,
    case_title: c.title,
    case_status: c.status,
    is_firm: firm(user),
    kinds,
    mask_rule_version: rules.version,
    server_today: tzToday(config.firmTz),
    firm_tz: config.firmTz,
  }
}

function briefDoc(d) {
  return {
    id: d.id,
    doc_kind: d.doc_kind,
    title: d.title,
    status: d.status,
    current_version: d.current_version,
    head_version_id: d.head_version_id,
    final_version_id: d.final_version_id,
    finalized_at: d.finalized_at,
    updated_at: d.updated_at,
  }
}

async function attachmentsForDoc(docId) {
  const atts = await query('SELECT * FROM writing_attachments WHERE doc_id = ? ORDER BY id', [docId])
  const out = []
  for (const a of atts) {
    const versions = await query('SELECT * FROM writing_attachment_versions WHERE attachment_id = ? ORDER BY version_no', [a.id])
    out.push({
      id: a.id,
      filename: a.filename,
      current_version: a.current_version,
      created_at: a.created_at,
      versions: versions.map((v) => ({
        id: v.id,
        version_no: v.version_no,
        size_bytes: v.size_bytes,
        content_type: v.content_type,
        status: v.status,
        parse_note: v.parse_note,
        uploaded_by_name: v.uploaded_by_name,
        created_at: v.created_at,
        parsed_at: v.parsed_at,
      })),
    })
  }
  return out
}

// 取某类文档的活动链
async function activeDocOfCase(caseId, kind) {
  const rows = await query(
    "SELECT * FROM writing_docs WHERE case_id = ? AND doc_kind = ? AND status <> '已作废' ORDER BY id DESC LIMIT 1",
    [caseId, kind]
  )
  return rows[0] || null
}

// ============ 建稿 / 作废 / 重开 ============

export async function createDoc(user, caseId, kind, body = {}) {
  await loadCase(user, caseId)
  if (!docKindDef(kind)) throw new ApiError(400, 'BAD_REQUEST', '未知撰稿类型')
  assertCanWrite(user, kind)
  const existed = await activeDocOfCase(caseId, kind)
  if (existed) throw new ApiError(409, 'DOC_EXISTS', `该案件已有${docKindDef(kind).label}文档（第 ${existed.current_version} 版），请在原链上继续。`)
  const now = nowIso()
  const id = await tx(async (d) =>
    d.insert(
      'INSERT INTO writing_docs (case_id, doc_kind, title, status, current_version, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
      [caseId, kind, String(body.title || '').slice(0, 200), DOC_STATUS.DRAFT, 0, user.id, now, now]
    )
  )
  return { id, status: DOC_STATUS.DRAFT, current_version: 0 }
}

export async function voidDoc(user, docId, { reason } = {}) {
  const d = await getDocById(docId)
  await loadCase(user, d.case_id)
  assertCanWrite(user, d.doc_kind)
  if (!reason || String(reason).trim().length < 2) throw new ApiError(400, 'REASON_REQUIRED', '作废必须填写原因（不少于 2 字），全程留痕。')
  if (d.status === DOC_STATUS.VOID) throw new ApiError(409, 'DOC_VOIDED', '该稿已作废。')
  const head = d.head_version_id ? await getVersionById(d.head_version_id) : null
  const now = nowIso()
  await tx(async (dh) => {
    // 作废也生成不可变版本：保留作废时全文快照与原因，链不再接受保存
    if (head) {
      const no = d.current_version + 1
      await dh.insert(
        `INSERT INTO writing_versions (doc_id, version_no, save_type, base_version_id, parent_version_id, content_json, summary, mask_snapshot_json, actor_id, actor_name, actor_role, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [d.id, no, '作废', head.id, head.id, head.content_json, `作废：${String(reason).trim()}`, head.mask_snapshot_json, user.id, user.name, user.role, now]
      )
      await dh.query('UPDATE writing_docs SET status = ?, current_version = ?, updated_at = ? WHERE id = ?', [DOC_STATUS.VOID, no, now, d.id])
    } else {
      await dh.query('UPDATE writing_docs SET status = ?, updated_at = ? WHERE id = ?', [DOC_STATUS.VOID, now, d.id])
    }
  })
  return { id: d.id, status: DOC_STATUS.VOID }
}

// 从历史版本（含作废链上的版本）重开：产生一条新链，首版复制源版本全文并留痕来源。
export async function restartFrom(user, caseId, kind, body = {}) {
  await loadCase(user, caseId)
  assertCanWrite(user, kind)
  const source = await getVersionById(Number(body.version_id))
  const sourceDoc = await getDocById(source.doc_id)
  if (sourceDoc.case_id !== Number(caseId) || sourceDoc.doc_kind !== kind) {
    throw new ApiError(400, 'BAD_REQUEST', '重开来源版本不属于本案该类文档')
  }
  const existed = await activeDocOfCase(caseId, kind)
  if (existed) throw new ApiError(409, 'DOC_EXISTS', '该案件已有活动撰稿链，请直接在链上「回到旧版本重开」，无需另起。')
  const now = nowIso()
  const snapshot = JSON.stringify((await activeRules()).rules)
  const result = await tx(async (dh) => {
    const docId = await dh.insert(
      'INSERT INTO writing_docs (case_id, doc_kind, title, status, current_version, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
      [caseId, kind, sourceDoc.title, DOC_STATUS.DRAFT, 0, user.id, now, now]
    )
    const vid = await dh.insert(
      `INSERT INTO writing_versions (doc_id, version_no, save_type, base_version_id, parent_version_id, branch_from_version_id, content_json, summary, mask_snapshot_json, actor_id, actor_name, actor_role, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [docId, 1, '草稿', null, null, source.id, source.content_json,
       `自${sourceDoc.status === DOC_STATUS.VOID ? '作废' : '历史'}稿第 ${source.version_no} 版重开`, snapshot, user.id, user.name, user.role, now]
    )
    await dh.query('UPDATE writing_docs SET current_version = 1, head_version_id = ?, updated_at = ? WHERE id = ?', [vid, now, docId])
    return { docId, vid }
  })
  return { id: result.docId, current_version: 1, head_version_id: result.vid }
}

// ============ 文档详情 / 版本 / diff ============

export async function getDocDetail(user, docId, { maskPreview = false } = {}) {
  const d = await getDocById(docId)
  await loadCase(user, d.case_id)
  assertCanRead(user, d.doc_kind)
  const viewer = maskPreview && firm(user) ? { ...user, role: 'client_admin' } : user
  const vrows = await query('SELECT * FROM writing_versions WHERE doc_id = ? ORDER BY version_no', [d.id])
  const versions = vrows.map((v) => {
    const pv = parseVersion(v)
    return {
      id: v.id,
      version_no: v.version_no,
      save_type: v.save_type,
      summary: v.summary,
      actor_name: v.actor_name,
      actor_role: v.actor_role,
      created_at: v.created_at,
      paragraphs: contentParagraphCount(pv.content),
      branch_from_version_id: v.branch_from_version_id,
      base_version_id: v.base_version_id,
      parent_version_id: v.parent_version_id,
    }
  })
  const conflicts = await query("SELECT * FROM writing_conflicts WHERE doc_id = ? AND status = '待取舍' ORDER BY id", [d.id])
  const vById = new Map(vrows.map((v) => [v.id, v]))
  const maskWithSnapshot = (text, baseVersionRow) => {
    if (firm(viewer) || text == null) return text
    const snap = baseVersionRow ? parseVersion(baseVersionRow).mask_snapshot : DEFAULT_RULES
    return maskTextSafeWith(text, snap)
  }
  return {
    ...briefDoc(d),
    case_id: d.case_id,
    kind_def: (() => {
      const def = docKindDef(d.doc_kind)
      return { key: def.key, label: def.label, sections: def.sections }
    })(),
    can_write: user.role === 'client_admin' ? d.doc_kind === 'disclosure' : firm(user),
    mask_preview: maskPreview && firm(user),
    versions,
    head: d.head_version_id ? presentVersion(vrows.find((v) => v.id === d.head_version_id), viewer) : null,
    final: d.final_version_id ? presentVersion(vrows.find((v) => v.id === d.final_version_id), viewer, {}) : null,
    conflicts: conflicts.map((c) => {
      const baseVer = vById.get(c.base_version_id)
      const snap = baseVer ? parseVersion(baseVer).mask_snapshot : DEFAULT_RULES
      let pendingContent = null
      if (c.pending_content_json) {
        const parsed = JSON.parse(c.pending_content_json)
        pendingContent = firm(viewer) ? parsed : maskContent(parsed, snap)
      }
      return {
        id: c.id,
        section_key: c.section_key,
        paragraph_id: c.paragraph_id,
        base_text: maskWithSnapshot(c.base_text, baseVer),
        incoming_text: maskWithSnapshot(c.incoming_text, baseVer),
        pending_text: maskWithSnapshot(c.pending_text, baseVer),
        incoming_actor_name: c.incoming_actor_name,
        pending_actor_name: c.pending_actor_name,
        base_version_id: c.base_version_id,
        incoming_version_id: c.incoming_version_id,
        created_at: c.created_at,
        pending_content: pendingContent,
      }
    }),
    attachments: await attachmentsForDoc(d.id),
  }
}

// 客户看冲突弹窗时同样按版本快照脱敏（冲突文本来自版本段落）
function maskTextSafeWith(text, rules = DEFAULT_RULES) {
  if (!text) return text
  let out = text
  for (const p of compilePatterns(rules)) {
    p.re.lastIndex = 0
    if (p.re.test(out)) { p.re.lastIndex = 0; out = out.replace(p.re, p.replacement) }
  }
  return out
}
const maskTextSafe = maskTextSafeWith

export async function getVersion(user, versionId) {
  const v = await getVersionById(versionId)
  const d = await getDocById(v.doc_id)
  await loadCase(user, d.case_id)
  assertCanRead(user, d.doc_kind)
  return { doc: briefDoc(d), version: presentVersion(v, user) }
}

export async function getDiff(user, docId, { from, to }) {
  const d = await getDocById(docId)
  await loadCase(user, d.case_id)
  assertCanRead(user, d.doc_kind)
  const vTo = await getVersionById(Number(to))
  const vFrom = from ? await getVersionById(Number(from)) : null
  if (vTo.doc_id !== d.id || (vFrom && vFrom.doc_id !== d.id)) throw new ApiError(400, 'BAD_REQUEST', '版本不属于该文档')
  const view = (v) => (firm(user) ? parseVersion(v).content : maskContent(parseVersion(v).content, parseVersion(v).mask_snapshot))
  const empty = { sections: [] }
  const diff = diffContent(vFrom ? view(vFrom) : empty, view(vTo))
  return {
    doc_id: d.id,
    from_version: vFrom ? { id: vFrom.id, version_no: vFrom.version_no, actor_name: vFrom.actor_name, created_at: vFrom.created_at } : null,
    to_version: { id: vTo.id, version_no: vTo.version_no, actor_name: vTo.actor_name, created_at: vTo.created_at },
    masked: !firm(user),
    ...diff,
  }
}

// ============ 保存版本（乐观并发 + 段落级冲突）============

async function assertHeadFresh(doc, baseVersionId) {
  if (!doc.head_version_id) return { base: null, head: null }
  if (!baseVersionId) {
    throw new ApiError(409, 'BASE_REQUIRED', '该文档已有历史版本，保存必须带所基于的版本号（base_version_id），用于并发冲突检测。')
  }
  const base = await getVersionById(Number(baseVersionId))
  if (base.doc_id !== doc.id) throw new ApiError(400, 'BAD_REQUEST', '基线版本不属于该文档')
  const head = await getVersionById(doc.head_version_id)
  return { base, head }
}

export async function saveVersion(user, caseId, kind, body = {}) {
  const c = await loadCase(user, caseId)
  if (!docKindDef(kind)) throw new ApiError(400, 'BAD_REQUEST', '未知撰稿类型')
  assertCanWrite(user, kind)
  const doc = await activeDocOfCase(caseId, kind)
  if (!doc) throw new ApiError(409, 'NO_ACTIVE_DOC', '还没有草稿，请先新建撰稿文档。')
  const finalize = Boolean(body.finalize)
  if (finalize && !firm(user)) throw new ApiError(403, 'ROLE_DENIED', '仅代理人侧可提交定稿。')

  const incoming = normalizeContent(kind, body.content)
  if (contentParagraphCount(incoming) === 0) throw new ApiError(400, 'EMPTY_CONTENT', '至少填写一个段落再保存。')

  const { base, head } = await assertHeadFresh(doc, body.base_version_id)
  const rules = await activeRules()
  const snapshotJson = JSON.stringify(rules.rules)

  // 定稿期限口径（与官文登记同一套引擎/同一套二次确认）
  let deadlineSpec = null
  if (finalize && body.deadline) {
    deadlineSpec = await resolveFinalDeadline(user, c, body)
  }

  // 客户在脱敏版上编辑：按「其所基于的版本」原文对账，还原客户视图里不可见的段落
  // （整章隐藏/sensitive/句内占位），防止不可见内容被占位符静默替换或删除。
  const pendingRaw = !firm(user) && base
    ? reconcileClientContent(parseVersion(base).content, incoming, parseVersion(base).mask_snapshot)
    : incoming

  let toSave = pendingRaw
  let branchFrom = null
  let autoMerged = 0

  if (head && base && head.id !== base.id) {
    // 双方基于同一版本各自改过：三路合并用各方真实原文（客户提交未经脱敏对账的形态由
    // reconcile 已还原不可见段），逐段判定
    const merged = threeWayMerge(parseVersion(base).content, parseVersion(head).content, pendingRaw, {
      incomingActorName: head.actor_name,
      pendingActorName: user.name,
    })
    autoMerged = merged.autoMerged
    if (merged.conflicts.length) {
      // 不覆盖、不拒绝：登记待取舍冲突（后来者本次尝试全文留痕），返回取舍界面所需全部数据。
      // 待取舍行幂等：同一 doc+paragraph 已有待取舍记录时复用，避免后来者反复撞出重复行。
      const now = nowIso()
      const registered = await tx(async (dh) => {
        const out = []
        for (const cf of merged.conflicts) {
          const exist = await dh.query(
            "SELECT id FROM writing_conflicts WHERE doc_id = ? AND section_key = ? AND paragraph_id = ? AND status = '待取舍'",
            [doc.id, cf.section_key, cf.paragraph_id]
          )
          let cid
          if (exist.length) {
            cid = exist[0].id
            await dh.query(
              'UPDATE writing_conflicts SET pending_text = ?, pending_actor_name = ?, pending_content_json = ? WHERE id = ?',
              [cf.pending_text ?? '', user.name, JSON.stringify(toSave), cid]
            )
          } else {
            cid = await dh.insert(
              `INSERT INTO writing_conflicts
                (doc_id, section_key, paragraph_id, base_version_id, incoming_version_id, base_text, incoming_text, pending_text, incoming_actor_name, pending_actor_name, pending_content_json, status, created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,'待取舍',?)`,
              [doc.id, cf.section_key, cf.paragraph_id, base.id, head.id,
               cf.base_text || '', cf.incoming_text ?? '', cf.pending_text ?? '',
               head.actor_name, user.name, JSON.stringify(toSave), now]
            )
          }
          out.push({ ...cf, id: cid })
        }
        return out
      })
      // 客户侧冲突弹窗只回传脱敏文本（用基线版本自带的规则快照，保证与所见一致）
      const maskTextFor = (t, rulesSnapshot) => {
        if (firm(user) || t == null) return t
        let out = String(t)
        for (const p of compilePatterns(rulesSnapshot)) {
          p.re.lastIndex = 0
          if (p.re.test(out)) { p.re.lastIndex = 0; out = out.replace(p.re, p.replacement) }
        }
        return out
      }
      const baseRules = parseVersion(base).mask_snapshot
      const clientConflicts = registered.map((cf) => (firm(user)
        ? cf
        : {
          ...cf,
          base_text: maskTextFor(cf.base_text, baseRules),
          incoming_text: maskTextFor(cf.incoming_text, baseRules),
          pending_text: maskTextFor(cf.pending_text, baseRules),
        }))
      throw new ApiError(409, 'PARAGRAPH_CONFLICT', `检测到 ${merged.conflicts.length} 处段落级冲突：对方的修改不会被覆盖，请逐段取舍后生成合并版本。`, {
        doc_id: doc.id,
        base_version: { id: base.id, version_no: base.version_no },
        head_version: { id: head.id, version_no: head.version_no, actor_name: head.actor_name, actor_role: head.actor_role, created_at: head.created_at },
        conflicts: clientConflicts,
        merged_preview: firm(user) ? merged.merged : maskContent(merged.merged, baseRules),
        auto_merged: autoMerged,
        pending_content: firm(user) ? toSave : maskContent(toSave, baseRules),
        masked: !firm(user),
      })
    }
    toSave = merged.merged
    branchFrom = base.id
  }

  if (head) {
    const headContent = parseVersion(head).content
    if (contentEqual(toSave, headContent)) throw new ApiError(400, 'NO_CHANGE', '内容与当前最新版本相同，未生成新版本。')
  }

  const now = nowIso()
  const saveType = finalize ? '定稿' : '草稿'
  const summary = String(body.summary || '').trim() || (finalize ? '提交定稿' : `保存草稿（${user.name}）`)
  const result = await tx(async (dh) => {
    const no = doc.current_version + 1
    const vid = await dh.insert(
      `INSERT INTO writing_versions (doc_id, version_no, save_type, base_version_id, parent_version_id, branch_from_version_id, content_json, summary, mask_snapshot_json, actor_id, actor_name, actor_role, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [doc.id, no, saveType, base?.id ?? null, head?.id ?? null, branchFrom, JSON.stringify(toSave), summary.slice(0, 300), snapshotJson,
       user.id, user.name, user.role, now]
    )
    await dh.query(
      'UPDATE writing_docs SET current_version = ?, head_version_id = ?, status = ?, finalized_at = ?, finalized_by = ?, updated_at = ? WHERE id = ?',
      [no, vid, finalize ? DOC_STATUS.FINAL : DOC_STATUS.DRAFT, finalize ? now : null, finalize ? user.id : null, now, doc.id]
    )
    let deadlineId = null
    if (deadlineSpec) {
      deadlineId = await dh.insert(
        `INSERT INTO deadlines (case_id, doc_id, writing_doc_id, dtype, anchor_basis, day_basis, start_date, duration_days, due_date, rolled, status, note, overdue_reason, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [caseId, null, doc.id, deadlineSpec.dtype, deadlineSpec.anchor, deadlineSpec.day_basis, deadlineSpec.start_date,
         deadlineSpec.duration_days, deadlineSpec.due_date, deadlineSpec.rolled ? 1 : 0, '待处理', deadlineSpec.note,
         deadlineSpec.overdue_reason, now]
      )
    }
    return { vid, no, deadlineId }
  })
  if (deadlineSpec) await bumpDash()
  return {
    doc_id: doc.id,
    version_id: result.vid,
    version_no: result.no,
    save_type: saveType,
    branched: Boolean(branchFrom),
    auto_merged: autoMerged,
    deadline: deadlineSpec ? { id: result.deadlineId, dtype: deadlineSpec.dtype, due_date: deadlineSpec.due_date, anchor: deadlineSpec.anchor, day_basis: deadlineSpec.day_basis } : null,
    status: finalize ? DOC_STATUS.FINAL : DOC_STATUS.DRAFT,
  }
}

// 定稿期限口径解析：与 docService.resolveStart/preview 同一套规则
export async function previewFinalDeadline(user, caseId, body = {}) {
  await loadCase(user, caseId)
  if (!firm(user)) throw new ApiError(403, 'ROLE_DENIED', '仅代理人侧可设定定稿提交期限')
  const spec = await resolveFinalDeadline(user, null, body, { previewOnly: true })
  return spec
}

async function resolveFinalDeadline(user, c, body, { previewOnly = false } = {}) {
  const dl = body.deadline || {}
  const anchor = dl.anchor || 'dispatch'
  const day_basis = dl.day_basis || 'natural'
  const duration_days = Math.trunc(Number(dl.duration_days))
  if (!ANCHORS.includes(anchor)) throw new ApiError(400, 'BAD_REQUEST', '起算口径只能是 receive（自收到日）或 dispatch（自发文日）')
  if (!DAY_BASES.includes(day_basis)) throw new ApiError(400, 'BAD_REQUEST', '天数口径只能是 natural / workday / legal')
  if (!Number.isFinite(duration_days) || duration_days <= 0) throw new ApiError(400, 'BAD_REQUEST', '期限天数必须是正整数')
  if (!dl.dispatch_date && !dl.receive_date) throw new ApiError(400, 'BAD_REQUEST', '请先填写发文日或收到日（定稿提交期限以何日为准须明示）')
  if (dl.dispatch_date && dl.receive_date && dl.receive_date < dl.dispatch_date) {
    throw new ApiError(400, 'BAD_REQUEST', '收到日不能早于发文日。')
  }
  const start = anchor === 'dispatch'
    ? { start_date: dl.dispatch_date, start_kind: '发文日' }
    : dl.receive_date
      ? { start_date: dl.receive_date, start_kind: '实际收到日' }
      : { start_date: addDays(dl.dispatch_date, 15), start_kind: '推定收到日（发文日+15日）' }
  if (!start.start_date) throw new ApiError(400, 'BAD_REQUEST', '所选起算口径缺少对应日期')
  const cal = await getCalendar()
  const r = computeDueDate({ start_date: start.start_date, duration_days, day_basis }, cal)
  const t = tzToday(config.firmTz)
  const left = daysLeft(r.due_date, t)
  const spec = {
    dtype: String(dl.dtype || '定稿提交').slice(0, 60),
    anchor,
    day_basis,
    duration_days,
    start_date: start.start_date,
    start_kind: start.start_kind,
    due_date: r.due_date,
    rolled: r.rolled,
    days_left: left,
    overdue: left < 0,
    server_today: t,
    firm_tz: config.firmTz,
    note: String(dl.note || '').slice(0, 300),
    overdue_reason: '',
  }
  if (previewOnly) return spec
  if (left < 0 && !body.confirm_overdue) {
    throw new ApiError(409, 'OVERDUE_CONFIRM', `按所选口径定稿提交截止日为 ${r.due_date}，截至代理所今日（${t}）已逾期 ${-left} 天。请确认后填写超期原因再提交定稿。`, { preview: spec })
  }
  if (left < 0 && String(body.overdue_reason || '').trim().length < 2) {
    throw new ApiError(400, 'OVERDUE_REASON_REQUIRED', '落点已逾期：必须填写超期原因（不少于 2 字），随期限留痕。', { preview: spec })
  }
  spec.overdue_reason = left < 0 ? String(body.overdue_reason).trim() : ''
  return spec
}

// ============ 段落冲突取舍 ============

export async function resolveConflicts(user, docId, body = {}) {
  const doc = await getDocById(docId)
  await loadCase(user, doc.case_id)
  assertCanWrite(user, doc.doc_kind)
  if (doc.status === DOC_STATUS.VOID) throw new ApiError(409, 'DOC_VOIDED', '该稿已作废。')
  const rows = await query("SELECT * FROM writing_conflicts WHERE doc_id = ? AND status = '待取舍' ORDER BY id", [docId])
  if (!rows.length) throw new ApiError(409, 'NO_CONFLICT', '没有待取舍的冲突（可能已被他人处理）。')
  const decisions = new Map((body.resolutions || []).map((r) => [Number(r.conflict_id ?? r.id), r]))
  if (!decisions.size) throw new ApiError(400, 'BAD_REQUEST', '请逐段给出取舍：incoming（采用对方）/ pending（保留我的）/ merged（合并文本）。')

  // 以最早一条冲突的共同基线判定链头是否又前进；前进则产生了新冲突，要求重新取舍。
  const base = await getVersionById(rows[0].base_version_id)
  const incomingVer = await getVersionById(rows[0].incoming_version_id)
  const submitted = normalizeContent(doc.doc_kind, body.pending_content)
  if (contentParagraphCount(submitted) === 0) throw new ApiError(400, 'EMPTY_CONTENT', '取舍后的合并稿不能为空。')
  // 客户在脱敏视图里取舍：先按基线原文对账不可见段（隐藏章/占位段），再参与合并
  const pendingContent = !firm(user)
    ? reconcileClientContent(parseVersion(base).content, submitted, parseVersion(base).mask_snapshot)
    : submitted
  const headNow = await getVersionById(doc.head_version_id)
  const replay = threeWayMerge(parseVersion(base).content, parseVersion(headNow).content, pendingContent, {
    incomingActorName: headNow.actor_name,
    pendingActorName: user.name,
  })
  if (headNow.id !== incomingVer.id) {
    // 取舍期间链头又前进（对方又保存了新版本）：拒绝静默合并，让前端拉最新重新取舍
    throw new ApiError(409, 'PARAGRAPH_CONFLICT', '你取舍期间对方又保存了新版本并产生新的冲突，请基于最新版本重新取舍。', {
      head_version: { id: headNow.id, version_no: headNow.version_no, actor_name: headNow.actor_name },
      conflicts: replay.conflicts,
      merged_preview: replay.merged,
      pending_content: pendingContent,
    })
  }

  // 在自动合并结果上逐段应用取舍
  const rowByKey = new Map(rows.map((r) => [`${r.section_key}|${r.paragraph_id}`, r]))
  const finalContent = { sections: replay.merged.sections.map((s) => ({ ...s })) }
  const resolvedMeta = []
  for (const sec of finalContent.sections) {
    const kept = []
    for (const p of sec.paragraphs) {
      const rec = rowByKey.get(`${sec.key}|${p.id}`)
      const dec = rec ? decisions.get(rec.id) : null
      if (!rec) { kept.push(p); continue }
      if (!dec) throw new ApiError(400, 'CONFLICT_UNRESOLVED', `仍有冲突段落未取舍（章节：${sec.title}）。`)
      let text
      if (dec.choice === 'incoming') {
        if (rec.incoming_text === '') { continue } // 对方删除 → 删除该段
        text = rec.incoming_text
      } else if (dec.choice === 'pending') {
        if (rec.pending_text === '') continue
        text = rec.pending_text
      } else if (dec.choice === 'merged') {
        text = String(dec.text ?? '').trim()
        if (!text) throw new ApiError(400, 'BAD_REQUEST', '选择「合并文本」时必须给出合并后的段落文字。')
        // 客户在脱敏视图下手工合并：保留下来的占位符按三方候选原文回填，绝不固化占位符
        if (!firm(user)) {
          text = restorePlaceholders(text, [rec.pending_text, rec.incoming_text, rec.base_text], parseVersion(base).mask_snapshot)
        }
      } else {
        throw new ApiError(400, 'BAD_REQUEST', '取舍只能是 incoming / pending / merged。')
      }
      kept.push({ id: p.id, text, sensitive: p.sensitive || false })
      resolvedMeta.push({ rec, choice: dec.choice, text })
    }
    sec.paragraphs = kept
  }
  // 决策里不能有对不上记录的 id
  for (const dec of decisions.keys()) {
    if (!rows.some((r) => r.id === dec)) throw new ApiError(400, 'BAD_REQUEST', `冲突 ${dec} 不属于该文档或已处理。`)
  }

  const rules = await activeRules()
  const now = nowIso()
  const summary = `冲突取舍合并（${rows.length} 段，${user.name}）`
  const newVid = await tx(async (dh) => {
    const no = doc.current_version + 1
    const vid = await dh.insert(
      `INSERT INTO writing_versions (doc_id, version_no, save_type, base_version_id, parent_version_id, branch_from_version_id, content_json, summary, mask_snapshot_json, actor_id, actor_name, actor_role, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [doc.id, no, '冲突合并', base.id, headNow.id, null, JSON.stringify(finalContent), summary, JSON.stringify(rules.rules),
       user.id, user.name, user.role, now]
    )
    for (const { rec, choice, text } of resolvedMeta) {
      await dh.query(
        `UPDATE writing_conflicts SET status = '已取舍', resolution = ?, resolved_text = ?, resolved_by = ?, resolved_version_id = ?, resolved_at = ? WHERE id = ?`,
        [choice, text, user.id, vid, now, rec.id]
      )
    }
    // 未出现在本次决策集合之外的待取舍记录不应存在（以 rows 为全集）；保险起见全部关闭
    const resolvedIds = new Set(resolvedMeta.map((m) => m.rec.id))
    for (const r of rows) {
      if (!resolvedIds.has(r.id)) {
        await dh.query(
          `UPDATE writing_conflicts SET status = '已取舍', resolution = 'incoming', resolved_text = incoming_text, resolved_by = ?, resolved_version_id = ?, resolved_at = ? WHERE id = ?`,
          [user.id, vid, now, r.id]
        )
      }
    }
    await dh.query('UPDATE writing_docs SET current_version = ?, head_version_id = ?, updated_at = ? WHERE id = ?', [no, vid, now, doc.id])
    return vid
  })
  return { doc_id: doc.id, version_id: newVid, version_no: doc.current_version + 1, save_type: '冲突合并', resolved: resolvedMeta.length }
}

// ============ 附件（对象存储，不入库；换版不可变）============

async function assertAttachmentAccess(user, doc, write) {
  await loadCase(user, doc.case_id)
  if (firm(user)) return
  if (user.role !== 'client_admin' || doc.doc_kind !== 'disclosure') {
    throw new ApiError(403, 'ROLE_DENIED', write ? '该类文档附件仅代理人侧可上传。' : '该类文档附件仅代理人侧可查看。')
  }
  if (write) assertCanWrite(user, doc.doc_kind)
}

// 两阶段上传之第一阶段：建附件版本行（解析中）+ 分配不可变 key 与一次性上传令牌。
// attachment_id 缺省 = 新附件；带已有 attachment_id = 原件换版（旧版本行与 key 原样保留）。
export async function initAttachment(user, docId, body = {}) {
  const doc = await getDocById(docId)
  await assertAttachmentAccess(user, doc, true)
  const filename = String(body.filename || '').trim()
  if (!filename) throw new ApiError(400, 'BAD_REQUEST', '附件文件名必填')
  const contentType = String(body.content_type || 'application/octet-stream').slice(0, 100)
  let attachmentId = Number(body.attachment_id) || null
  const now = nowIso()
  const result = await tx(async (dh) => {
    if (!attachmentId) {
      attachmentId = await dh.insert('INSERT INTO writing_attachments (doc_id, filename, current_version, created_at) VALUES (?,?,0,?)',
        [doc.id, filename.slice(0, 250), now])
    } else {
      const rows = await dh.query('SELECT * FROM writing_attachments WHERE id = ? AND doc_id = ?', [attachmentId, doc.id])
      if (!rows.length) throw new ApiError(404, 'NOT_FOUND', '附件不存在或不属于该文档')
    }
    const prev = await dh.query('SELECT COALESCE(MAX(version_no),0) AS n FROM writing_attachment_versions WHERE attachment_id = ?', [attachmentId])
    const versionNo = Number(prev[0].n) + 1
    // 先占位：上传完成前 key 已登记，状态为解析中；key 不可变，换版永远走新版本号
    const tempKey = buildObjectKey({ attachmentId, versionNo, filename })
    const vid = await dh.insert(
      `INSERT INTO writing_attachment_versions (attachment_id, version_no, object_key, size_bytes, content_type, status, uploaded_by, uploaded_by_name, created_at)
       VALUES (?,?,?,0,?,'解析中',?,?,?)`,
      [attachmentId, versionNo, tempKey, contentType, user.id, user.name, now]
    )
    return { attachmentId, versionNo, versionId: vid, objectKey: tempKey }
  })
  const token = grantUpload(result.objectKey)
  return {
    attachment_id: result.attachmentId,
    version_id: result.versionId,
    version_no: result.versionNo,
    object_key: result.objectKey,
    upload_token: token,
    upload_url: `/api/writing/attachments/upload/${result.versionId}`,
    expires_in_seconds: 600,
  }
}

// 第二阶段：二进制落对象存储（由 raw body 路由调用），落库仅回填大小，不写内容。
export async function putAttachmentBytes(user, versionId, buf, token) {
  const vrows = await query('SELECT * FROM writing_attachment_versions WHERE id = ?', [versionId])
  if (!vrows.length) throw new ApiError(404, 'NOT_FOUND', '附件版本不存在')
  const v = vrows[0]
  if (v.status !== '解析中' || v.size_bytes > 0) throw new ApiError(409, 'ALREADY_UPLOADED', '该附件版本已上传，不可覆盖；请发起换版。')
  const doc = await getDocById((await query('SELECT doc_id FROM writing_attachments WHERE id = ?', [v.attachment_id]))[0].doc_id)
  await assertAttachmentAccess(user, doc, true)
  const grant = consumeUploadGrant(token, v.object_key)
  if (!grant.ok) throw new ApiError(401, 'UPLOAD_GRANT_INVALID', grant.reason)
  if (!buf || !buf.length) throw new ApiError(400, 'EMPTY_FILE', '上传内容为空')
  await putObject(v.object_key, buf) // wx 兜底：key 已存在直接失败
  await tx(async (dh) => {
    await dh.query('UPDATE writing_attachment_versions SET size_bytes = ? WHERE id = ?', [buf.length, v.id])
    await dh.query('UPDATE writing_attachments SET current_version = ? WHERE id = ?', [v.version_no, v.attachment_id])
  })
  return { attachment_id: v.attachment_id, version_id: v.id, version_no: v.version_no, size_bytes: buf.length, status: '解析中' }
}

// 模拟原件解析流水线完成（OCR/结构化抽取等）：仅状态回填，内容永不入库。
export async function markAttachmentParsed(user, versionId, body = {}) {
  const vrows = await query('SELECT * FROM writing_attachment_versions WHERE id = ?', [versionId])
  if (!vrows.length) throw new ApiError(404, 'NOT_FOUND', '附件版本不存在')
  const att = (await query('SELECT * FROM writing_attachments WHERE id = ?', [vrows[0].attachment_id]))[0]
  const doc = await getDocById(att.doc_id)
  await assertAttachmentAccess(user, doc, true)
  const status = body.status === '解析失败' ? '解析失败' : '已完成'
  await query('UPDATE writing_attachment_versions SET status = ?, parse_note = ?, parsed_at = ? WHERE id = ?',
    [status, String(body.parse_note || '').slice(0, 300), nowIso(), versionId])
  return { id: Number(versionId), status }
}

export async function downloadAttachmentVersion(user, attachmentId, versionNo) {
  const att = (await query('SELECT * FROM writing_attachments WHERE id = ?', [attachmentId]))[0]
  if (!att) throw new ApiError(404, 'NOT_FOUND', '附件不存在')
  const doc = await getDocById(att.doc_id)
  await assertAttachmentAccess(user, doc, false)
  const no = versionNo ? Number(versionNo) : att.current_version
  const vrows = await query('SELECT * FROM writing_attachment_versions WHERE attachment_id = ? AND version_no = ?', [attachmentId, no])
  if (!vrows.length) throw new ApiError(404, 'NOT_FOUND', '该附件版本不存在')
  const v = vrows[0]
  if (!v.size_bytes) throw new ApiError(409, 'NOT_UPLOADED', '该版本尚未上传完成（对象存储中无原件）。')
  let buf
  try {
    buf = await getObject(v.object_key)
  } catch {
    throw new ApiError(404, 'OBJECT_MISSING', '对象存储中未找到该版本原件（key 不可变，不会被换版影响）。')
  }
  return { filename: att.filename, version_no: v.version_no, content_type: v.content_type || 'application/octet-stream', buf }
}

// ============ 脱敏规则版本管理 ============

export async function listMaskRules() {
  const rows = await query('SELECT id, version, is_active, note, created_at FROM mask_rules ORDER BY version DESC')
  const cur = await activeRules()
  return { current_version: cur.version, rules: cur.rules, history: rows }
}

export async function createMaskRules(user, body = {}) {
  if (user.role !== 'admin') throw new ApiError(403, 'ROLE_DENIED', '仅管理员可以发布新的脱敏规则版本')
  const rules = body.rules
  if (!rules || !Array.isArray(rules.patterns) || !Array.isArray(rules.hideSections)) {
    throw new ApiError(400, 'BAD_REQUEST', '规则需含 patterns 数组与 hideSections 数组')
  }
  for (const p of rules.patterns) {
    try { new RegExp(p.regex, p.flags || 'g') } catch { throw new ApiError(400, 'BAD_REQUEST', `规则「${p.name || p.id}」正则不合法`) }
  }
  const cur = await activeRules()
  const nextVersion = cur.version + 1
  const payload = { version: nextVersion, hideSections: rules.hideSections, hideSensitiveParagraphs: rules.hideSensitiveParagraphs !== false, patterns: rules.patterns }
  const now = nowIso()
  await tx(async (dh) => {
    await dh.query('UPDATE mask_rules SET is_active = 0 WHERE is_active = 1')
    await dh.insert('INSERT INTO mask_rules (version, rules_json, is_active, created_by, created_at, note) VALUES (?,?,1,?,?,?)',
      [nextVersion, JSON.stringify(payload), user.id, now, String(body.note || '').slice(0, 300)])
  })
  return { version: nextVersion, rules: payload }
}
