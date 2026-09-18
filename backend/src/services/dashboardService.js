import { query } from '../db.js'
import { redis } from '../redis.js'
import { tzToday, daysFromNow, daysBetween } from '../lib/dates.js'
import { maskedName, isFirmRole } from '../lib/mask.js'
import { ACTIVE_STATUSES } from '../lib/stateMachine.js'
import { stageCompletion, docCompletion, STAGE_METRIC_LABEL, DOC_METRIC_LABEL } from '../lib/completion.js'
import { DOC_STATUS } from '../lib/docStatus.js'
import { config } from '../config.js'

// 任何案件/官文/期限/费用/客户/合同变更后调用：版本号+1 使全部 dashboard 缓存失效
export async function bumpDash() {
  try {
    await redis().incr('dash:version')
  } catch {}
}

export async function getDashboard(user) {
  const v = (await redis().get('dash:version')) || '0'
  const scope = user.role === 'client_admin' ? `c${user.client_id}` : 'firm'
  const key = `dash:${v}:${user.role}:${scope}`
  try {
    const hit = await redis().get(key)
    if (hit) return JSON.parse(hit)
  } catch {}
  const data = await buildDashboard(user)
  try {
    await redis().set(key, JSON.stringify(data), 'EX', 20)
  } catch {}
  return data
}

async function buildDashboard(user) {
  const scoped = user.role === 'client_admin'
  const cid = scoped ? user.client_id : null
  const firm = isFirmRole(user.role)
  const t = tzToday(config.firmTz)

  // ---- 各客户待处理漏斗 ----
  const clients = scoped
    ? await query('SELECT * FROM clients WHERE id = ?', [cid])
    : await query('SELECT * FROM clients ORDER BY id')
  const funnels = []
  for (const cl of clients) {
    const rows = await query('SELECT status, COUNT(*) AS n FROM cases WHERE client_id = ? GROUP BY status', [cl.id])
    const byStatus = {}
    for (const r of rows) byStatus[r.status] = Number(r.n)
    const active = rows.filter((r) => ACTIVE_STATUSES.includes(r.status)).reduce((s, r) => s + Number(r.n), 0)
    const pend = await query(
      "SELECT COUNT(*) AS n FROM deadlines dl JOIN cases c ON c.id = dl.case_id WHERE c.client_id = ? AND dl.status = '待处理'",
      [cl.id]
    )
    const od = await query(
      "SELECT COUNT(*) AS n FROM fees f JOIN cases c ON c.id = f.case_id WHERE c.client_id = ? AND f.status = '待缴' AND f.due_date < ?",
      [cl.id, t]
    )
    const masked = firm && active > 0
    funnels.push({
      client_id: cl.id,
      client_name: masked ? maskedName(cl) : cl.name,
      masked,
      by_status: byStatus,
      pending_deadlines: Number(pend[0].n),
      overdue_fees: Number(od[0].n),
    })
  }

  // ---- 官文期限（30 天内 + 已逾期，按到期日升序）----
  const scopeDl = scoped ? 'AND c.client_id = ?' : ''
  const dlRows = await query(
    `SELECT dl.id, dl.dtype, dl.due_date, dl.note, dl.anchor_basis, dl.day_basis, dl.rolled,
            c.id AS case_id, c.case_no, c.title AS case_title, c.status AS case_status,
            cl.id AS client_id, cl.name AS client_name, cl.code AS client_code, cl.short_code AS client_short_code
     FROM deadlines dl JOIN cases c ON c.id = dl.case_id JOIN clients cl ON cl.id = c.client_id
     WHERE dl.status = '待处理' AND dl.due_date <= ? ${scopeDl}
     ORDER BY dl.due_date ASC LIMIT 50`,
    scoped ? [daysFromNow(30, new Date(`${t}T00:00:00Z`)), cid] : [daysFromNow(30, new Date(`${t}T00:00:00Z`))]
  )
  const deadlines = dlRows.map((r) => ({
    id: r.id,
    dtype: r.dtype,
    due_date: r.due_date,
    d_day: daysBetween(t, r.due_date),
    overdue: r.due_date < t,
    rolled: Boolean(r.rolled),
    anchor_basis: r.anchor_basis,
    day_basis: r.day_basis,
    note: r.note,
    case_id: r.case_id,
    case_no: r.case_no,
    case_title: r.case_title,
    client_name: firm && r.case_status !== '委托中' ? `${r.client_short_code}·${r.client_code}` : r.client_name,
  }))

  // ---- 缴费逾期（红点）----
  const feeParams = scoped ? [t, cid] : [t]
  const feeRows = await query(
    `SELECT f.id, f.kind, f.amount, f.due_date, c.id AS case_id, c.case_no, c.title AS case_title, c.status AS case_status,
            cl.name AS client_name, cl.code AS client_code, cl.short_code AS client_short_code
     FROM fees f JOIN cases c ON c.id = f.case_id JOIN clients cl ON cl.id = c.client_id
     WHERE f.status = '待缴' AND f.due_date < ? ${scopeDl}
     ORDER BY f.due_date ASC LIMIT 50`,
    feeParams
  )
  const overdueFees = feeRows.map((r) => ({
    id: r.id,
    kind: r.kind,
    amount: Number(r.amount),
    due_date: r.due_date,
    overdue_days: daysBetween(r.due_date, t),
    case_id: r.case_id,
    case_no: r.case_no,
    case_title: r.case_title,
    client_name: firm && r.case_status !== '委托中' ? `${r.client_short_code}·${r.client_code}` : r.client_name,
  }))

  // ---- KPI ----
  const kpiParams = scoped ? [cid] : []
  const kpiWhere = scoped ? 'WHERE client_id = ?' : ''
  const placeholders = ACTIVE_STATUSES.map(() => '?').join(',')
  const activeCases = await query(
    `SELECT COUNT(*) AS n FROM cases ${kpiWhere}${kpiWhere ? ' AND' : 'WHERE'} status IN (${placeholders})`,
    [...kpiParams, ...ACTIVE_STATUSES]
  )
  const soon7 = deadlines.filter((d) => !d.overdue && d.d_day <= 7).length
  const overdueDl = deadlines.filter((d) => d.overdue).length

  // ---- 完成度（两口径，全系统同一实现；作战台/案件详情/CSV 导出一致）----
  const caseScope = scoped ? 'WHERE c.client_id = ?' : ''
  const caseParams = scoped ? [cid] : []
  const allCases = await query(
    `SELECT c.id, c.case_no, c.title, c.status, c.ctype, c.client_id,
            cl.name AS client_name, cl.code AS client_code, cl.short_code AS client_short_code
     FROM cases c JOIN clients cl ON cl.id = c.client_id ${caseScope} ORDER BY c.updated_at DESC LIMIT 500`,
    caseParams
  )
  const evRows = await query(
    `SELECT c.id AS case_id, e.to_status FROM case_events e JOIN cases c ON c.id = e.case_id ${caseScope ? 'WHERE c.client_id = ?' : ''}`,
    caseParams
  )
  const docRows = await query(
    `SELECT c.id AS case_id, o.status FROM official_docs o JOIN cases c ON c.id = o.case_id ${caseScope ? 'WHERE c.client_id = ?' : ''}`,
    caseParams
  )
  const reachedMap = new Map(allCases.map((c) => [c.id, new Set()]))
  for (const e of evRows) reachedMap.get(e.case_id)?.add(e.to_status)
  const docsMap = new Map(allCases.map((c) => [c.id, []]))
  for (const d of docRows) docsMap.get(d.case_id)?.push(d)

  const caseCompletion = allCases.map((c) => {
    const masked = firm && c.status !== '委托中'
    return {
      case_id: c.id,
      case_no: c.case_no,
      case_title: c.title,
      status: c.status,
      ctype: c.ctype,
      client_id: c.client_id,
      client_name: masked ? `${c.client_short_code}·${c.client_code}` : c.client_name,
      stage: stageCompletion(c.ctype, reachedMap.get(c.id)),
      doc: docCompletion(docsMap.get(c.id)),
    }
  })
  const avg = (xs) => (xs.length ? Math.round(xs.reduce((s, x) => s + x, 0) / xs.length) : 0)
  const completion = {
    firm_tz: config.firmTz,
    server_today: t,
    stage_label: STAGE_METRIC_LABEL,
    doc_label: DOC_METRIC_LABEL,
    stage_avg: avg(caseCompletion.map((c) => c.stage.percent)),
    doc_avg: avg(caseCompletion.map((c) => c.doc.percent)),
    cases: caseCompletion,
  }

  return {
    generated_at: new Date().toISOString(),
    server_today: t,
    firm_tz: config.firmTz,
    kpi: {
      active_cases: Number(activeCases[0].n),
      pending_deadlines: deadlines.length,
      due_in_7d: soon7,
      overdue_deadlines: overdueDl,
      overdue_fees: overdueFees.length,
      overdue_fee_amount: overdueFees.reduce((s, f) => s + f.amount, 0),
    },
    funnels,
    deadlines,
    overdue_fees: overdueFees,
    completion,
  }
}
