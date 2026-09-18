import { query, tx, insert } from '../db.js'
import { ApiError } from '../middleware/error.js'
import { assertClientAccess } from '../middleware/auth.js'
import { checkTransition } from '../lib/stateMachine.js'
import { docTypeDef, ANCHOR_LABELS } from '../lib/docTypes.js'
import { DOC_STATUS } from '../lib/docStatus.js'
import { computeDueDate, daysLeft, DAY_BASES, ANCHORS } from '../lib/deadlineCalc.js'
import { getCalendar } from './holidayService.js'
import { nowIso, tzToday, addDays, daysBetween } from '../lib/dates.js'
import { config } from '../config.js'
import { bumpDash } from './dashboardService.js'

function maskClientName(r, firm) {
  return firm && r.case_status !== '委托中' ? `${r.client_short_code}·${r.client_code}` : r.client_name
}

// 组装官文展示对象：补推定收到日（发文日+15 日）
function presentDoc(r) {
  return {
    ...r,
    presumed_receive_date: r.dispatch_date && !r.receive_date ? addDays(r.dispatch_date, 15) : null,
  }
}

async function loadCase(user, caseId) {
  const rows = await query('SELECT * FROM cases WHERE id = ?', [caseId])
  if (!rows.length) throw new ApiError(404, 'NOT_FOUND', '案件不存在')
  assertClientAccess(user, rows[0].client_id)
  return rows[0]
}

// 期限起算日解析：自收到日优先实际收到日，缺省用推定收到日（发文日+15）；自发文日直接取发文日。
export function resolveStart({ anchor, dispatch_date, receive_date }) {
  if (anchor === 'dispatch') {
    if (!dispatch_date) return { error: '选择了「自发文日」起算，但未登记发文日。' }
    return { start_date: dispatch_date, start_kind: '发文日' }
  }
  if (receive_date) return { start_date: receive_date, start_kind: '实际收到日' }
  if (dispatch_date) return { start_date: addDays(dispatch_date, 15), start_kind: '推定收到日（发文日+15日）' }
  return { error: '缺少起算依据：请至少登记发文日或收到日。' }
}

/**
 * 到期日预览（不落库）：登记表单实时调用，界面明示起算口径/天数口径/剩余天数。
 */
export async function previewDeadline(user, caseId, body = {}) {
  await loadCase(user, caseId)
  const anchor = body.anchor || 'receive'
  const day_basis = body.day_basis || 'legal'
  const n = Math.trunc(Number(body.duration_days))
  if (!ANCHORS.includes(anchor)) throw new ApiError(400, 'BAD_REQUEST', '起算口径只能是 receive（自收到日）或 dispatch（自发文日）')
  if (!DAY_BASES.includes(day_basis)) throw new ApiError(400, 'BAD_REQUEST', '天数口径只能是 natural / workday / legal')
  if (!Number.isFinite(n) || n <= 0) throw new ApiError(400, 'BAD_REQUEST', '期限天数必须是正整数')
  if (!body.dispatch_date && !body.receive_date) throw new ApiError(400, 'BAD_REQUEST', '请先填写发文日或收到日')
  const resolved = resolveStart({ anchor, dispatch_date: body.dispatch_date, receive_date: body.receive_date })
  if (resolved.error) throw new ApiError(400, 'BAD_REQUEST', resolved.error)
  const cal = await getCalendar()
  const r = computeDueDate({ start_date: resolved.start_date, duration_days: n, day_basis }, cal)
  const t = tzToday(config.firmTz)
  const left = daysLeft(r.due_date, t)
  return {
    start_date: resolved.start_date,
    start_kind: resolved.start_kind,
    anchor,
    anchor_label: ANCHOR_LABELS[anchor],
    day_basis,
    duration_days: n,
    due_date: r.due_date,
    rolled: r.rolled,
    days_left: left,
    overdue: left < 0,
    server_today: t,
    firm_tz: config.firmTz,
  }
}

/**
 * 登记官文。
 * 官文类型带状态效力（docTypes.to）的驱动案件流转，仍逐条过状态机（禁跳步/非法回退）；
 * 中性官文只登记。可同时按类型默认口径生成一条法定期限。
 * 落点已逾期时必须 confirm_overdue=true 且填写 overdue_reason（二次确认留痕）。
 */
export async function registerDoc(user, caseId, body = {}) {
  const c = await loadCase(user, caseId)
  const {
    doc_type, doc_no = '', dispatch_date = null, receive_date = null, note = '',
    create_deadline: createDeadline = true, deadline: dlOverride = null,
    confirm_overdue: confirmOverdue = false, overdue_reason: overdueReason = '',
  } = body
  const def = docTypeDef(doc_type)
  if (!def) throw new ApiError(400, 'BAD_REQUEST', `未知官文类型「${doc_type}」`)
  if (!dispatch_date && !receive_date) throw new ApiError(400, 'BAD_REQUEST', '请至少填写发文日或收到日')
  if (dispatch_date && receive_date && receive_date < dispatch_date) {
    throw new ApiError(400, 'BAD_REQUEST', '收到日不能早于发文日，请核对纸质通知书/电子文情日期。')
  }

  // 状态效力校验：同态为幂等（如实审中再收到审查意见），跳步/非法回退/越权一律拒绝
  let chk = { ok: true, noop: !def.to || c.status === def.to }
  if (def.to && c.status !== def.to) {
    const signed = await query("SELECT id FROM contracts WHERE client_id = ? AND status = '已签署'", [c.client_id])
    chk = checkTransition({
      from: c.status, to: def.to, role: user.role, isAssignee: c.agent_id === user.id,
      hasContract: signed.length > 0, hasAgent: Boolean(c.agent_id), ctype: c.ctype,
    })
    if (!chk.ok) throw new ApiError(chk.http, chk.code, chk.message)
  }

  // 期限计算（默认取官文类型口径，允许登记时在界面上改口径/天数）
  let preview = null
  let dlSpec = null
  if (createDeadline && def.deadline) {
    const spec0 = def.deadline
    const anchor = dlOverride?.anchor || spec0.anchor
    const day_basis = dlOverride?.day_basis || spec0.dayBasis
    const duration_days = Math.trunc(Number(dlOverride?.duration_days ?? spec0.days))
    const dlLabel = dlOverride?.label || spec0.label
    if (!ANCHORS.includes(anchor) || !DAY_BASES.includes(day_basis) || duration_days <= 0) {
      throw new ApiError(400, 'BAD_REQUEST', '期限口径不合法')
    }
    const resolved = resolveStart({ anchor, dispatch_date, receive_date })
    if (resolved.error) throw new ApiError(400, 'BAD_REQUEST', resolved.error)
    const cal = await getCalendar()
    const r = computeDueDate({ start_date: resolved.start_date, duration_days, day_basis }, cal)
    const t = tzToday(config.firmTz)
    preview = { label: dlLabel, anchor, day_basis, duration_days, start_date: resolved.start_date, start_kind: resolved.start_kind, due_date: r.due_date, rolled: r.rolled, days_left: daysLeft(r.due_date, t) }
    if (preview.days_left < 0 && !confirmOverdue) {
      throw new ApiError(409, 'OVERDUE_CONFIRM', `按所选口径该期限到期日为 ${r.due_date}，截至代理所今日（${t}）已逾期 ${-preview.days_left} 天。请确认后填写超期补登原因再提交。`, { preview })
    }
    if (preview.days_left < 0 && (!overdueReason || String(overdueReason).trim().length < 2)) {
      throw new ApiError(400, 'OVERDUE_REASON_REQUIRED', '落点已逾期：必须填写超期补登原因（不少于 2 个字），留痕备查。', { preview })
    }
    dlSpec = { ...preview, overdue_reason: preview.days_left < 0 ? String(overdueReason).trim() : '' }
  }

  const now = nowIso()
  const result = await tx(async (d) => {
    const docId = await d.insert(
      `INSERT INTO official_docs (case_id, doc_type, doc_no, dispatch_date, receive_date, status, note, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [caseId, doc_type, doc_no, dispatch_date, receive_date, DOC_STATUS.REGISTERED, note, user.id, now]
    )
    let deadlineId = null
    if (dlSpec) {
      deadlineId = await d.insert(
        `INSERT INTO deadlines (case_id, doc_id, dtype, anchor_basis, day_basis, start_date, duration_days, due_date, rolled, status, note, overdue_reason, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [caseId, docId, dlSpec.label, dlSpec.anchor, dlSpec.day_basis, dlSpec.start_date, dlSpec.duration_days,
         dlSpec.due_date, dlSpec.rolled ? 1 : 0, '待处理', note, dlSpec.overdue_reason, now]
      )
      await d.query('UPDATE official_docs SET deadline_id = ? WHERE id = ?', [deadlineId, docId])
    }
    let transitioned = null
    if (def.to && !chk.noop) {
      await d.query('UPDATE cases SET status = ?, version = version + 1, updated_at = ? WHERE id = ?', [def.to, now, caseId])
      await d.insert(
        'INSERT INTO case_events (case_id, from_status, to_status, action, actor_id, actor_name, reason, doc_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        [caseId, c.status, def.to, `官文登记：${doc_type}`, user.id, user.name, note, docId, now]
      )
      transitioned = { from: c.status, to: def.to, label: chk.label }
    }
    return { docId, deadlineId, transitioned }
  })
  await bumpDash()
  return {
    id: result.docId,
    deadline_id: result.deadlineId,
    transitioned: result.transitioned,
    case_status: result.transitioned?.to || c.status,
    deadline_preview: preview,
  }
}

// 归档（幂等）：已撤回不可归档
export async function archiveDoc(user, docId) {
  const rows = await query('SELECT * FROM official_docs WHERE id = ?', [docId])
  if (!rows.length) throw new ApiError(404, 'NOT_FOUND', '官文不存在')
  assertClientAccess(user, rows[0].case_id)
  const doc = rows[0]
  if (doc.status === DOC_STATUS.WITHDRAWN) throw new ApiError(409, 'DOC_WITHDRAWN', '该官文已撤回，不能归档。')
  if (doc.status !== DOC_STATUS.ARCHIVED) {
    await query('UPDATE official_docs SET status = ?, archived_at = ? WHERE id = ?', [DOC_STATUS.ARCHIVED, nowIso(), docId])
    await bumpDash()
  }
  return presentDoc((await query('SELECT * FROM official_docs WHERE id = ?', [docId]))[0])
}

// 撤回（必须填原因留痕）：已归档不可撤回；幂等返回现状
export async function withdrawDoc(user, docId, { reason } = {}) {
  if (!reason || String(reason).trim().length < 2) {
    throw new ApiError(400, 'BAD_REQUEST', '撤回官文必须填写原因（不少于 2 个字），全程留痕。')
  }
  const rows = await query('SELECT * FROM official_docs WHERE id = ?', [docId])
  if (!rows.length) throw new ApiError(404, 'NOT_FOUND', '官文不存在')
  assertClientAccess(user, rows[0].case_id)
  const doc = rows[0]
  if (doc.status === DOC_STATUS.ARCHIVED) throw new ApiError(409, 'DOC_ARCHIVED', '该官文已归档，不能撤回；如属误归档请联系管理员处理。')
  if (doc.status !== DOC_STATUS.WITHDRAWN) {
    await query('UPDATE official_docs SET status = ?, withdraw_reason = ?, withdrawn_at = ? WHERE id = ?',
      [DOC_STATUS.WITHDRAWN, String(reason).trim(), nowIso(), docId])
    await bumpDash()
  }
  return presentDoc((await query('SELECT * FROM official_docs WHERE id = ?', [docId]))[0])
}

export async function listDocsForCase(caseId) {
  const rows = await query('SELECT * FROM official_docs WHERE case_id = ? ORDER BY COALESCE(dispatch_date, receive_date) DESC, id DESC', [caseId])
  return rows.map(presentDoc)
}

/**
 * 日历区间数据：区间内的官文（发文日/收到日落点）与期限（到期日落点）。
 * basis: dispatch | receive | due 控制官文按哪个日期落点（默认发文日）。
 */
export async function getCalendarRange(user, { from, to, basis = 'dispatch' } = {}) {
  if (!from || !to || from > to) throw new ApiError(400, 'BAD_REQUEST', '日历区间参数不合法（from/to，YYYY-MM-DD）')
  const scoped = user.role === 'client_admin'
  const firm = ['admin', 'agent', 'reviewer'].includes(user.role)
  const scopeSql = scoped ? 'AND c.client_id = ?' : ''
  // 按收到日落点时，未补录收到日的官文按发文日+15 日推定，可能落在区间而发文日在区间外；
  // 故发文日窗口向前放宽 20 日，最终落点由前端按区间过滤。
  const dispatchFrom = basis === 'receive' ? addDays(from, -20) : from
  const docRows = await query(
    `SELECT o.*, c.id AS case_id, c.case_no, c.title AS case_title, c.status AS case_status, c.client_id AS c_client_id,
            cl.name AS client_name, cl.code AS client_code, cl.short_code AS client_short_code
     FROM official_docs o JOIN cases c ON c.id = o.case_id JOIN clients cl ON cl.id = c.client_id
     WHERE (
       (o.dispatch_date BETWEEN ? AND ?)
       OR (o.receive_date BETWEEN ? AND ?)
     ) ${scopeSql}
     ORDER BY o.dispatch_date ASC, o.id ASC LIMIT 500`,
    scoped ? [dispatchFrom, to, from, to, user.client_id] : [dispatchFrom, to, from, to]
  )
  const dlRows = await query(
    `SELECT dl.*, c.id AS case_id, c.case_no, c.title AS case_title, c.status AS case_status,
            cl.name AS client_name, cl.code AS client_code, cl.short_code AS client_short_code
     FROM deadlines dl JOIN cases c ON c.id = dl.case_id JOIN clients cl ON cl.id = c.client_id
     WHERE dl.due_date BETWEEN ? AND ? ${scopeSql}
     ORDER BY dl.due_date ASC, dl.id ASC LIMIT 500`,
    scoped ? [from, to, user.client_id] : [from, to]
  )
  const t = tzToday(config.firmTz)
  const docs = docRows.map((r) => ({
    ...presentDoc(r),
    client_name: maskClientName(r, firm),
    dispatch_in_range: r.dispatch_date >= from && r.dispatch_date <= to,
    receive_in_range: Boolean(r.receive_date && r.receive_date >= from && r.receive_date <= to),
  }))
  const deadlines = dlRows.map((r) => ({
    ...r,
    rolled: Boolean(r.rolled),
    overdue: r.status === '待处理' && r.due_date < t,
    days_left: daysBetween(t, r.due_date),
    client_name: maskClientName(r, firm),
  }))
  return { from, to, basis, server_today: t, docs, deadlines }
}

