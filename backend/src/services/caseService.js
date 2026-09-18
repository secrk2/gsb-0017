import { query, tx, isDupErr } from '../db.js'
import { ApiError } from '../middleware/error.js'
import { assertClientAccess } from '../middleware/auth.js'
import { checkTransition, allowedTransitionsFor } from '../lib/stateMachine.js'
import { isFirmRole } from '../lib/mask.js'
import { nowIso, tzToday, daysBetween } from '../lib/dates.js'
import { stageCompletion, docCompletion } from '../lib/completion.js'
import { config } from '../config.js'
import { listDocsForCase } from './docService.js'
import { bumpDash } from './dashboardService.js'

function presentCase(r, user) {
  const masked = isFirmRole(user.role) && r.status !== '委托中'
  return {
    id: r.id,
    case_no: r.case_no,
    client_uuid: r.client_uuid,
    client_id: r.client_id,
    client_name: masked ? `${r.client_short_code}·${r.client_code}` : r.client_name,
    client_masked: masked,
    contract_id: r.contract_id,
    title: r.title,
    ctype: r.ctype,
    status: r.status,
    agent_id: r.agent_id,
    agent_name: r.agent_name,
    priority: r.priority,
    version: r.version,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }
}

const CASE_SELECT = `SELECT c.*, cl.name AS client_name, cl.code AS client_code, cl.short_code AS client_short_code,
                     u.name AS agent_name
                     FROM cases c JOIN clients cl ON cl.id = c.client_id LEFT JOIN users u ON u.id = c.agent_id`

// 轻量访问校验（官文清单等只需要确认案件可见的接口复用）
export async function assertCaseAccess(user, caseId) {
  const rows = await query('SELECT client_id FROM cases WHERE id = ?', [caseId])
  if (!rows.length) throw new ApiError(404, 'NOT_FOUND', '案件不存在')
  assertClientAccess(user, rows[0].client_id)
}

export async function listCases(user, { status, client_id, mine } = {}) {
  const conds = []
  const params = []
  if (user.role === 'client_admin') {
    conds.push('c.client_id = ?')
    params.push(user.client_id)
  } else if (client_id) {
    conds.push('c.client_id = ?')
    params.push(client_id)
  }
  if (status) {
    conds.push('c.status = ?')
    params.push(status)
  }
  if (mine) {
    conds.push('c.agent_id = ?')
    params.push(user.id)
  }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : ''
  const rows = await query(`${CASE_SELECT} ${where} ORDER BY c.updated_at DESC, c.id DESC LIMIT 500`, params)
  return rows.map((r) => presentCase(r, user))
}

// 剩余天数等派生字段一律按代理所时区今日计算
function decorateDeadline(d, t) {
  return {
    ...d,
    rolled: Boolean(d.rolled),
    overdue: d.status === '待处理' && d.due_date < t,
    days_left: d.status === '待处理' ? daysBetween(t, d.due_date) : null,
  }
}

export async function getCaseDetail(user, caseId) {
  const rows = await query(`${CASE_SELECT} WHERE c.id = ?`, [caseId])
  if (!rows.length) throw new ApiError(404, 'NOT_FOUND', '案件不存在')
  const c = rows[0]
  assertClientAccess(user, c.client_id)
  const t = tzToday(config.firmTz)
  const events = await query('SELECT * FROM case_events WHERE case_id = ? ORDER BY id ASC', [caseId])
  const deadlines = await query('SELECT * FROM deadlines WHERE case_id = ? ORDER BY due_date ASC', [caseId])
  const fees = await query('SELECT * FROM fees WHERE case_id = ? ORDER BY due_date ASC', [caseId])
  const contracts = await query('SELECT id, contract_no, title, status, signed_at FROM contracts WHERE client_id = ?', [c.client_id])
  const docs = await listDocsForCase(caseId)
  const isAssignee = c.agent_id === user.id
  // 完成度两口径：同一来源 lib/completion.js，作战台/导出复用
  const reached = new Set(events.map((e) => e.to_status))
  const completion = {
    server_today: t,
    firm_tz: config.firmTz,
    stage: stageCompletion(c.ctype, reached),
    doc: docCompletion(docs),
  }
  return {
    ...presentCase(c, user),
    contract_no: contracts[0]?.contract_no || null,
    events,
    docs,
    completion,
    deadlines: deadlines.map((d) => decorateDeadline(d, t)),
    fees: fees.map((f) => ({ ...f, amount: Number(f.amount), overdue: f.status === '待缴' && f.due_date < t })),
    allowed_transitions: allowedTransitionsFor(c.status, user.role, isAssignee, c.ctype),
    can_reveal: isFirmRole(user.role) && c.status !== '委托中',
  }
}

// 创建委托案件。client_uuid 由前端生成（离线场景先于本地存在），
// 数据库唯一约束兜底：断网重试/重复提交/批量同步重放都不会产生重复案件。
export async function createCase(user, payload) {
  const { client_uuid, client_id, title, ctype = '发明', priority = '普通', contract_id = null } = payload || {}
  if (!client_uuid || !client_id || !title) {
    throw new ApiError(400, 'BAD_REQUEST', '缺少必填字段：client_uuid / client_id / title')
  }
  assertClientAccess(user, Number(client_id))
  const clients = await query('SELECT id FROM clients WHERE id = ?', [client_id])
  if (!clients.length) throw new ApiError(404, 'NOT_FOUND', '客户不存在')
  if (contract_id) {
    const cs = await query('SELECT id FROM contracts WHERE id = ? AND client_id = ?', [contract_id, client_id])
    if (!cs.length) throw new ApiError(400, 'BAD_REQUEST', '合同不属于该客户')
  }
  const now = nowIso()
  try {
    const id = await tx(async (d) => {
      const newId = await d.insert(
        `INSERT INTO cases (case_no, client_uuid, client_id, contract_id, title, ctype, status, agent_id, priority, version, created_by, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [`TMP-${client_uuid}`, client_uuid, client_id, contract_id, title, ctype, '委托中', null, priority, 1, user.id, now, now]
      )
      const caseNo = `AL-${now.slice(0, 4)}-${String(newId).padStart(4, '0')}`
      await d.query('UPDATE cases SET case_no = ? WHERE id = ?', [caseNo, newId])
      await d.insert(
        'INSERT INTO case_events (case_id, from_status, to_status, action, actor_id, actor_name, reason, created_at) VALUES (?,?,?,?,?,?,?,?)',
        [newId, null, '委托中', '创建委托', user.id, user.name, '', now]
      )
      return newId
    })
    await bumpDash()
    return { case: await getCaseDetail(user, id), deduped: false }
  } catch (e) {
    if (isDupErr(e)) {
      const rows = await query('SELECT id FROM cases WHERE client_uuid = ?', [client_uuid])
      if (rows.length) return { case: await getCaseDetail(user, rows[0].id), deduped: true }
    }
    throw e
  }
}

// 状态流转：状态机统一校验（非法回退/跳步/越权均带原因拦截）
export async function transitionCase(user, caseId, { to, reason = '', agent_id = null } = {}) {
  const rows = await query('SELECT * FROM cases WHERE id = ?', [caseId])
  if (!rows.length) throw new ApiError(404, 'NOT_FOUND', '案件不存在')
  const c = rows[0]
  assertClientAccess(user, c.client_id)
  const signed = await query("SELECT id FROM contracts WHERE client_id = ? AND status = '已签署'", [c.client_id])
  const chk = checkTransition({
    from: c.status,
    to,
    role: user.role,
    isAssignee: c.agent_id === user.id,
    hasContract: signed.length > 0,
    hasAgent: Boolean(agent_id || c.agent_id),
    ctype: c.ctype,
  })
  if (!chk.ok) throw new ApiError(chk.http, chk.code, chk.message)
  if (chk.noop) return { case: await getCaseDetail(user, caseId), noop: true }
  const finalAgent = agent_id ?? c.agent_id
  const now = nowIso()
  await tx(async (d) => {
    await d.query('UPDATE cases SET status = ?, agent_id = ?, version = version + 1, updated_at = ? WHERE id = ?', [
      to,
      finalAgent,
      now,
      caseId,
    ])
    await d.insert(
      'INSERT INTO case_events (case_id, from_status, to_status, action, actor_id, actor_name, reason, created_at) VALUES (?,?,?,?,?,?,?,?)',
      [caseId, c.status, to, chk.label, user.id, user.name, reason, now]
    )
  })
  await bumpDash()
  return { case: await getCaseDetail(user, caseId) }
}
