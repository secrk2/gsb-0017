import { query, insert } from '../db.js'
import { ApiError } from '../middleware/error.js'
import { assertClientAccess } from '../middleware/auth.js'
import { nowIso, tzToday } from '../lib/dates.js'
import { DAY_BASES, ANCHORS } from '../lib/deadlineCalc.js'
import { config } from '../config.js'
import { bumpDash } from './dashboardService.js'

async function loadCaseForWrite(user, caseId) {
  const rows = await query('SELECT id, client_id FROM cases WHERE id = ?', [caseId])
  if (!rows.length) throw new ApiError(404, 'NOT_FOUND', '案件不存在')
  assertClientAccess(user, rows[0].client_id)
  return rows[0]
}

// 手工登记期限（不经官文）。落点已逾期时必须二次确认 + 填原因留痕。
export async function addDeadline(user, caseId, body = {}) {
  const {
    dtype, due_date, note = '',
    anchor_basis: anchor = 'receive', day_basis: basis = 'natural',
    start_date: startDate = null, duration_days: durationDays = null,
    confirm_overdue: confirmOverdue = false, overdue_reason: overdueReason = '',
  } = body
  if (!dtype || !due_date) throw new ApiError(400, 'BAD_REQUEST', '缺少必填字段：dtype / due_date')
  if (!ANCHORS.includes(anchor) || !DAY_BASES.includes(basis)) {
    throw new ApiError(400, 'BAD_REQUEST', '期限口径不合法：anchor_basis / day_basis')
  }
  await loadCaseForWrite(user, caseId)
  const t = tzToday(config.firmTz)
  if (due_date < t) {
    if (!confirmOverdue) {
      throw new ApiError(409, 'OVERDUE_CONFIRM', `到期日 ${due_date} 早于代理所今日（${t}），该期限登记即超期。请确认并填写超期补登原因后再提交。`)
    }
    if (!overdueReason || String(overdueReason).trim().length < 2) {
      throw new ApiError(400, 'OVERDUE_REASON_REQUIRED', '超期补登必须填写原因（不少于 2 个字），留痕备查。')
    }
  }
  const id = await insert(
    `INSERT INTO deadlines (case_id, doc_id, dtype, anchor_basis, day_basis, start_date, duration_days, due_date, rolled, status, note, overdue_reason, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [caseId, null, dtype, anchor, basis, startDate, durationDays == null ? null : Math.trunc(Number(durationDays)),
     due_date, 0, '待处理', note, due_date < t ? String(overdueReason).trim() : '', nowIso()]
  )
  await bumpDash()
  return { id }
}

// 幂等：重复完成返回当前状态，不报错（离线重试安全）
export async function completeDeadline(user, deadlineId) {
  const rows = await query('SELECT dl.*, c.client_id FROM deadlines dl JOIN cases c ON c.id = dl.case_id WHERE dl.id = ?', [deadlineId])
  if (!rows.length) throw new ApiError(404, 'NOT_FOUND', '期限不存在')
  assertClientAccess(user, rows[0].client_id)
  if (rows[0].status !== '已完成') {
    await query("UPDATE deadlines SET status = '已完成', completed_at = ? WHERE id = ?", [nowIso(), deadlineId])
    await bumpDash()
  }
  return (await query('SELECT * FROM deadlines WHERE id = ?', [deadlineId]))[0]
}

export async function addFee(user, caseId, { kind, amount, due_date } = {}) {
  if (!kind || amount == null || !due_date) throw new ApiError(400, 'BAD_REQUEST', '缺少必填字段：kind / amount / due_date')
  await loadCaseForWrite(user, caseId)
  const id = await insert('INSERT INTO fees (case_id, kind, amount, due_date, status, created_at) VALUES (?,?,?,?,?,?)', [
    caseId,
    kind,
    amount,
    due_date,
    '待缴',
    nowIso(),
  ])
  await bumpDash()
  return { id }
}

// 幂等：重复缴费返回当前状态
export async function payFee(user, feeId) {
  const rows = await query('SELECT f.*, c.client_id FROM fees f JOIN cases c ON c.id = f.case_id WHERE f.id = ?', [feeId])
  if (!rows.length) throw new ApiError(404, 'NOT_FOUND', '费用记录不存在')
  assertClientAccess(user, rows[0].client_id)
  if (rows[0].status !== '已缴') {
    await query("UPDATE fees SET status = '已缴', paid_at = ? WHERE id = ?", [nowIso(), feeId])
    await bumpDash()
  }
  return (await query('SELECT * FROM fees WHERE id = ?', [feeId]))[0]
}
