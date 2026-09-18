import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { boot, login, api } from './helpers.js'

let server
let base
const tokens = {}

before(async () => {
  ;({ server, base } = await boot())
  for (const u of ['admin', 'agent01', 'agent02', 'reviewer01', 'client01', 'client02']) {
    tokens[u] = await login(base, u)
  }
})

after(() => server.close())

test('健康检查', async () => {
  const r = await fetch(`${base}/api/health`)
  const j = await r.json()
  assert.equal(r.status, 200)
  assert.equal(j.data.db, 'up')
  assert.equal(j.data.redis, 'up')
})

test('登录：错误密码 401，未带 token 401', async () => {
  const bad = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'wrong' }),
  })
  assert.equal(bad.status, 401)
  const noToken = await fetch(`${base}/api/cases`)
  assert.equal(noToken.status, 401)
})

test('作战台：3 家客户漏斗、脱敏、9 件在办、逾期费用 3 笔、带时区今日与完成度口径', async () => {
  const r = await api(base, tokens.admin).get('/dashboard')
  assert.equal(r.status, 200)
  const d = r.body.data
  assert.equal(d.funnels.length, 3)
  for (const f of d.funnels) {
    assert.equal(f.masked, true)
    assert.match(f.client_name, /^[A-Z]+·KH-\d{4}$/)
  }
  assert.equal(d.kpi.overdue_fees, 3)
  // 12 件：授权 1、驳回 1、无效 1 已结案，其余 9 件在办
  assert.equal(d.kpi.active_cases, 9)
  assert.ok(d.deadlines.length > 0)
  assert.ok(d.deadlines.some((x) => x.overdue), '存在已逾期官文期限')
  assert.ok(d.overdue_fees[0].case_no)
  assert.match(d.server_today, /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(d.firm_tz, 'Asia/Shanghai')
  assert.match(d.completion.stage_label, /关键阶段/)
  assert.match(d.completion.doc_label, /官文归档/)
  assert.ok(d.completion.cases.length === 12)
})

test('客户管理员：作战台与列表仅见本客户，且名称不脱敏', async () => {
  const d = (await api(base, tokens.client01).get('/dashboard')).body.data
  assert.equal(d.funnels.length, 1)
  assert.equal(d.funnels[0].masked, false)
  assert.equal(d.funnels[0].client_name, '华芯半导体科技有限公司')
  const clients = (await api(base, tokens.client01).get('/clients')).body.data
  assert.equal(clients.length, 1)
  assert.equal(clients[0].name, '华芯半导体科技有限公司')
})

test('客户隔离：越权访问他人案件/客户/官文一律 403（非空白）', async () => {
  const c1 = api(base, tokens.client01)
  const cases = (await c1.get('/cases')).body.data
  assert.ok(cases.length > 0)
  assert.ok(cases.every((c) => c.client_id === 1))
  const forbidden = await c1.get('/cases/8')
  assert.equal(forbidden.status, 403)
  assert.equal(forbidden.body.error.code, 'FORBIDDEN')
  assert.match(forbidden.body.error.message, /无权访问其他客户/)
  assert.equal((await c1.get('/clients/2')).status, 403)
  assert.equal((await c1.get('/clients/3')).status, 403)
  const t = await c1.post('/cases/8/transition', { to: '受理' })
  assert.equal(t.status, 403)
  // 越权登记官文
  const d2 = await c1.post('/cases/8/docs', { doc_type: '审查意见通知书（其他）', dispatch_date: '2026-09-01' })
  assert.equal(d2.status, 403)
  const own = await c1.get('/cases/1')
  assert.equal(own.status, 200)
  assert.equal(own.body.data.client_name, '华芯半导体科技有限公司')
})

test('委托→立项→申请→受理→初审→实审→授权 全链路 + 回退/跳步/类型分叉拦截', async () => {
  const admin = api(base, tokens.admin)
  const cl = await admin.post('/clients', { name: '测试客户·量子计算研究院', short_code: 'QK', contact_name: '孙老师' })
  assert.equal(cl.status, 201)
  const clientId = cl.body.data.id
  const cs = await admin.post('/cases', { client_uuid: 'it-flow-0001', client_id: clientId, title: '量子纠错编码方法', ctype: '发明' })
  assert.equal(cs.status, 201)
  const caseId = cs.body.data.case.id
  assert.equal(cs.body.data.case.status, '委托中')
  const noContract = await admin.post(`/cases/${caseId}/transition`, { to: '已立项', agent_id: 2 })
  assert.equal(noContract.status, 409)
  assert.equal(noContract.body.error.code, 'NO_CONTRACT')
  const ct = await admin.post(`/clients/${clientId}/contracts`, { title: '专利代理委托合同（量子院）', amount: 60000 })
  assert.equal(ct.status, 201)
  assert.equal((await admin.post(`/clients/${clientId}/contracts`, { title: 'x' })).status, 409)
  const noAgent = await admin.post(`/cases/${caseId}/transition`, { to: '已立项' })
  assert.equal(noAgent.status, 409)
  assert.equal(noAgent.body.error.code, 'NO_AGENT')
  const init = await admin.post(`/cases/${caseId}/transition`, { to: '已立项', agent_id: 2, reason: '新案分配' })
  assert.equal(init.status, 200)
  assert.equal(init.body.data.case.status, '已立项')
  // 非法回退
  assert.equal((await admin.post(`/cases/${caseId}/transition`, { to: '委托中' })).status, 409)
  // 跳步：已立项 → 实审中（必须经过 申请/受理/初审）
  const skip = await admin.post(`/cases/${caseId}/transition`, { to: '实审中' })
  assert.equal(skip.status, 409)
  assert.equal(skip.body.error.code, 'ILLEGAL_TRANSITION')
  // 非名下代理人提交申请 → 403；名下代理人 → 200
  assert.equal((await api(base, tokens.agent02).post(`/cases/${caseId}/transition`, { to: '申请' })).status, 403)
  const owner = await api(base, tokens.agent01).post(`/cases/${caseId}/transition`, { to: '申请' })
  assert.equal(owner.status, 200)
  assert.equal(owner.body.data.case.status, '申请')
  // 逐步推进：受理 → 初审
  for (const [to, label] of [['受理', '受理登记'], ['初审', '进入初审']]) {
    const r = await admin.post(`/cases/${caseId}/transition`, { to })
    assert.equal(r.status, 200, `${to}: ${r.body?.error?.message || ''}`)
    assert.equal(r.body.data.case.status, to)
  }
  // 发明案件初审不能直接授权（类型分叉）
  const mismatch = await admin.post(`/cases/${caseId}/transition`, { to: '授权' })
  assert.equal(mismatch.status, 409)
  assert.equal(mismatch.body.error.code, 'CTYPE_PATH_MISMATCH')
  // 跳步：受理已过，初审→申请 回退非法；进入实审合法
  assert.equal((await admin.post(`/cases/${caseId}/transition`, { to: '已立项' })).status, 409)
  const exam = await admin.post(`/cases/${caseId}/transition`, { to: '实审中' })
  assert.equal(exam.status, 200)
  // 代理人登记授权 → 403；审核员登记授权 → 200
  assert.equal((await api(base, tokens.agent01).post(`/cases/${caseId}/transition`, { to: '授权' })).status, 403)
  const grant = await api(base, tokens.reviewer01).post(`/cases/${caseId}/transition`, { to: '授权', reason: '授权通知书已发文' })
  assert.equal(grant.status, 200)
  // 授权后可受理无效
  const invalid = await admin.post(`/cases/${caseId}/transition`, { to: '无效' })
  assert.equal(invalid.status, 200)
  // 流转事件完整留痕
  const detail = await admin.get(`/cases/${caseId}`)
  const actions = detail.body.data.events.map((e) => e.action)
  assert.deepEqual(actions, ['创建委托', '立项', '提交申请', '受理登记', '进入初审', '进入实审', '授权登记', '无效宣告受理'])
})

test('实用新型初审合格可直接授权', async () => {
  const admin = api(base, tokens.admin)
  const cs = await admin.post('/cases', { client_uuid: 'it-util-0001', client_id: 1, title: '快速授权夹具结构', ctype: '实用新型' })
  const id = cs.body.data.case.id
  await admin.post(`/cases/${id}/transition`, { to: '已立项', agent_id: 2 })
  for (const to of ['申请', '受理', '初审', '授权']) {
    const r = await admin.post(`/cases/${id}/transition`, { to })
    assert.equal(r.status, 200, `${to}: ${r.body?.error?.message || ''}`)
  }
  assert.equal((await admin.get(`/cases/${id}`)).body.data.status, '授权')
})

test('脱敏与留痕：代理人二次确认填理由看全名', async () => {
  const agent = api(base, tokens.agent01)
  const cases = (await agent.get('/cases')).body.data
  const c1 = cases.find((c) => c.id === 1)
  assert.equal(c1.client_name, 'HX·KH-0001')
  assert.equal(c1.client_masked, true)
  const c4 = cases.find((c) => c.id === 4)
  assert.equal(c4.client_name, '华芯半导体科技有限公司')
  assert.equal(c4.client_masked, false)
  assert.equal((await agent.post('/clients/1/reveal', { reason: '' })).status, 400)
  const reveal = await agent.post('/clients/1/reveal', { reason: '答复审查意见需核对申请人全称', case_id: 1 })
  assert.equal(reveal.status, 200)
  assert.equal(reveal.body.data.name, '华芯半导体科技有限公司')
  assert.equal(reveal.body.data.logged, true)
  const logs = (await api(base, tokens.reviewer01).get('/logs/unmask')).body.data
  assert.ok(logs.some((l) => l.user_name === '李慕华' && l.reason.includes('核对申请人')))
  assert.equal((await api(base, tokens.client01).post('/clients/1/reveal', { reason: '看看' })).status, 403)
  assert.equal((await api(base, tokens.client01).get('/logs/unmask')).status, 403)
})

test('幂等：Idempotency-Key 重放与 client_uuid 去重，不产生重复案件', async () => {
  const admin = api(base, tokens.admin)
  const before1 = (await admin.get('/cases?client_id=2')).body.data.length
  const key = 'it-idem-key-1'
  const p1 = await admin.post('/cases', { client_uuid: 'it-idem-uuid-1', client_id: 2, title: '幂等测试案件A' }, { 'Idempotency-Key': key })
  const p2 = await admin.post('/cases', { client_uuid: 'it-idem-uuid-1', client_id: 2, title: '幂等测试案件A' }, { 'Idempotency-Key': key })
  assert.equal(p1.status, 201)
  assert.equal(p2.status, 201)
  assert.equal(p2.headers.get('x-idempotent-replay'), 'true')
  assert.equal(p1.body.data.case.id, p2.body.data.case.id)
  const p3 = await admin.post('/cases', { client_uuid: 'it-idem-uuid-1', client_id: 2, title: '幂等测试案件A' }, { 'Idempotency-Key': 'it-idem-key-2' })
  assert.equal(p3.status, 200)
  assert.equal(p3.body.data.deduped, true)
  assert.equal(p3.body.data.case.id, p1.body.data.case.id)
  const after1 = (await admin.get('/cases?client_id=2')).body.data.length
  assert.equal(after1, before1 + 1, '三次提交只产生一件案件')
})

test('离线合并：批量同步幂等去重、官文操作、冲突带回服务器现状', async () => {
  const admin = api(base, tokens.admin)
  assert.equal((await api(base, tokens.client01).post('/sync/batch', { ops: [] })).status, 403)
  // 案件 9 种子处于「申请」，离线期间依次推进到实审中
  const ops1 = [
    { key: 'sync-k1', op: 'case.create', payload: { client_uuid: 'it-sync-uuid-1', client_id: 3, title: '离线新建·巡检机器人路径规划' } },
    { key: 'sync-k2a', op: 'case.transition', payload: { case_id: 9, to: '受理' } },
    { key: 'sync-k2b', op: 'case.transition', payload: { case_id: 9, to: '初审' } },
    { key: 'sync-k2c', op: 'case.transition', payload: { case_id: 9, to: '实审中' } },
    { key: 'sync-k-doc', op: 'doc.register', payload: { case_id: 9, body: { doc_type: '缴费通知书', dispatch_date: '2026-09-10', receive_date: '2026-09-14', create_deadline: false } } },
  ]
  const batch1 = await admin.post('/sync/batch', { ops: ops1 })
  assert.equal(batch1.status, 200)
  const r = batch1.body.data.results
  assert.equal(r[0].status, 'applied')
  assert.equal(r[1].status, 'applied')
  assert.equal(r[2].status, 'applied')
  assert.equal(r[3].status, 'applied')
  assert.equal(r[4].status, 'applied')
  assert.equal(r[4].data.case_status, '实审中')
  const newCaseId = r[0].data.case_id
  // 重放：全部 duplicate，不产生重复案件/官文
  const batch2 = await admin.post('/sync/batch', { ops: ops1 })
  for (const x of batch2.body.data.results) assert.equal(x.status, 'duplicate')
  const starCases = (await admin.get('/cases?client_id=3')).body.data
  assert.equal(starCases.filter((c) => c.client_uuid === 'it-sync-uuid-1').length, 1)
  // 冲突：实审中 → 已立项 非法回退
  const batch3 = await admin.post('/sync/batch', {
    ops: [{ key: 'sync-k3', op: 'case.transition', payload: { case_id: 9, to: '已立项' } }],
  })
  const r3 = batch3.body.data.results[0]
  assert.equal(r3.status, 'conflict')
  assert.equal(r3.code, 'ILLEGAL_ROLLBACK')
  assert.equal((await admin.get('/cases/9')).body.data.status, '实审中')
  // 跳步冲突：新案件还在委托中，离线队列直接推到实审中
  const batch4 = await admin.post('/sync/batch', {
    ops: [{ key: 'sync-k4', op: 'case.transition', payload: { case_id: newCaseId, to: '实审中' } }],
  })
  assert.equal(batch4.body.data.results[0].status, 'conflict')
  assert.equal(batch4.body.data.results[0].code, 'ILLEGAL_TRANSITION')
})

test('官文登记：驱动状态机流转并按口径自动生成期限，事件留痕', async () => {
  const admin = api(base, tokens.admin)
  // 案件 3 种子处于「受理」（实用新型），登记初审意见 → 进入初审
  const reg = await admin.post('/cases/3/docs', {
    doc_type: '初步审查意见通知书',
    doc_no: 'CN2026-初审-0001',
    dispatch_date: '2026-09-01',
    receive_date: '2026-09-05',
    note: '集成测试登记',
  })
  assert.equal(reg.status, 201)
  assert.equal(reg.body.data.case_status, '初审')
  assert.deepEqual(reg.body.data.transitioned, { from: '受理', to: '初审', label: '进入初审' })
  assert.ok(reg.body.data.deadline_id)
  const detail = (await admin.get('/cases/3')).body.data
  assert.equal(detail.status, '初审')
  const doc = detail.docs.find((x) => x.id === reg.body.data.id)
  assert.equal(doc.doc_no, 'CN2026-初审-0001')
  assert.equal(doc.status, '已登记')
  assert.equal(doc.presumed_receive_date, null) // 有实际收到日则无推定日
  const ev = detail.events.find((e) => e.doc_id === doc.id)
  assert.equal(ev.action, '官文登记：初步审查意见通知书')
  assert.equal(ev.to_status, '初审')
  const dl = detail.deadlines.find((x) => x.id === reg.body.data.deadline_id)
  assert.equal(dl.anchor_basis, 'receive')
  assert.equal(dl.day_basis, 'legal')
  assert.equal(dl.duration_days, 30)
  assert.equal(dl.start_date, '2026-09-05')
})

test('官文登记：跳步官文被状态机拒绝（受理态直接登记授权）', async () => {
  const admin = api(base, tokens.admin)
  // 案件 3 已在初审；登记无效宣告（仅授权后可受理）→ 非法流转
  const r = await admin.post('/cases/3/docs', {
    doc_type: '无效宣告请求受理通知书', dispatch_date: '2026-09-10', receive_date: '2026-09-12', create_deadline: false,
  })
  assert.equal(r.status, 409)
  assert.equal(r.body.error.code, 'ILLEGAL_TRANSITION')
})

test('超期落点：未二次确认 409，缺原因 400，补齐原因 201 并留痕', async () => {
  const admin = api(base, tokens.admin)
  // 案件 6 实用新型处于初审；初审驳回 90 天复审期限，1 月收到 → 落点早已逾期
  const body = { doc_type: '驳回决定（初步审查）', dispatch_date: '2026-01-01', receive_date: '2026-01-05' }
  const r1 = await admin.post('/cases/6/docs', body)
  assert.equal(r1.status, 409)
  assert.equal(r1.body.error.code, 'OVERDUE_CONFIRM')
  assert.ok(r1.body.error.details.preview.days_left < 0)
  const r2 = await admin.post('/cases/6/docs', { ...body, confirm_overdue: true })
  assert.equal(r2.status, 400)
  assert.equal(r2.body.error.code, 'OVERDUE_REASON_REQUIRED')
  const r3 = await admin.post('/cases/6/docs', { ...body, confirm_overdue: true, overdue_reason: '纸质通知书收发室延误，客户上周才转交，已提示复审期限风险。' })
  assert.equal(r3.status, 201)
  assert.equal(r3.body.data.case_status, '驳回')
  const detail = (await admin.get('/cases/6')).body.data
  const dl = detail.deadlines.find((x) => x.id === r3.body.data.deadline_id)
  assert.match(dl.overdue_reason, /收发室延误/)
  assert.equal(dl.overdue, true)
})

test('推定收到日：只登记发文日时按发文日+15 日起算', async () => {
  const admin = api(base, tokens.admin)
  const pv = await admin.post('/cases/3/deadline-preview', {
    anchor: 'receive', day_basis: 'natural', duration_days: 10, dispatch_date: '2026-09-01',
  })
  assert.equal(pv.status, 200)
  assert.equal(pv.body.data.start_date, '2026-09-16')
  assert.match(pv.body.data.start_kind, /推定收到日/)
  assert.equal(pv.body.data.due_date, '2026-09-26')
})

test('官文归档与撤回：归档后不可撤回，撤回必须填原因，撤回不计入归档完成度', async () => {
  const admin = api(base, tokens.admin)
  const reg = await admin.post('/cases/3/docs', { doc_type: '缴费通知书', dispatch_date: '2026-09-12', receive_date: '2026-09-15', create_deadline: false })
  const id = reg.body.data.id
  const arc = await admin.post(`/docs/${id}/archive`)
  assert.equal(arc.status, 200)
  assert.equal(arc.body.data.status, '已归档')
  assert.equal((await admin.post(`/docs/${id}/withdraw`, { reason: '误操作' })).status, 409)
  // 案件 9 种子官文已撤回；缺原因拒绝，带原因重复撤回幂等
  const c9 = (await admin.get('/cases/9')).body.data
  const withdrawnDoc = c9.docs.find((d) => d.status === '已撤回')
  assert.ok(withdrawnDoc, '案件 9 的官文全部撤回（空态样例）')
  assert.match(withdrawnDoc.withdraw_reason, /误发/)
  assert.equal((await admin.post(`/docs/${withdrawnDoc.id}/withdraw`, {})).status, 400)
  const again = await admin.post(`/docs/${withdrawnDoc.id}/withdraw`, { reason: '再次确认撤回' })
  assert.equal(again.status, 200)
  assert.equal(again.body.data.status, '已撤回')
  // 完成度：案件 9 有一条撤回官文（同步测试另登记了一条中性官文），归档口径完成数为 0
  assert.equal(c9.completion.doc.done, 0)
  assert.equal(c9.completion.doc.percent, 0)
  assert.ok(c9.completion.doc.total >= 1)
})

test('日历区间：返回区间内官文与期限落点、代理所今日', async () => {
  const admin = api(base, tokens.admin)
  const r = await admin.get('/calendar?from=2026-09-01&to=2026-09-30')
  assert.equal(r.status, 200)
  const cal = r.body.data
  assert.ok(Array.isArray(cal.docs) && cal.docs.length > 0)
  assert.ok(Array.isArray(cal.deadlines) && cal.deadlines.length > 0)
  assert.match(cal.server_today, /^\d{4}-\d{2}-\d{2}$/)
  for (const x of cal.deadlines) {
    assert.ok(x.due_date >= '2026-09-01' && x.due_date <= '2026-09-30')
    assert.equal(typeof x.days_left, 'number')
  }
  // 非法区间 400
  assert.equal((await admin.get('/calendar?from=2026-09-30&to=2026-09-01')).status, 400)
})

test('CSV 导出：含完成度两口径列，与作战台同口径', async () => {
  const admin = api(base, tokens.admin)
  const r = await fetch(`${base}/api/dashboard/export.csv`, { headers: { Authorization: `Bearer ${tokens.admin}` } })
  assert.equal(r.status, 200)
  assert.match(r.headers.get('content-type'), /text\/csv/)
  const text = await r.text()
  assert.ok(text.includes('关键阶段完成度%'))
  assert.ok(text.includes('官文归档完成度%'))
  assert.ok(text.includes('AL-2026-'))
  // 与作战台聚合数字一致（取案件 3 一行核对关键阶段完成数）
  const dash = (await admin.get('/dashboard')).body.data.completion
  const rowCase3 = dash.cases.find((c) => c.case_no === 'AL-2026-0003')
  assert.ok(text.includes(`${rowCase3.stage.done},${rowCase3.stage.total},${rowCase3.stage.percent}`))
})

test('期限与费用：完成/缴纳幂等', async () => {
  const admin = api(base, tokens.admin)
  const d1 = await admin.post('/ops/deadlines/1/complete')
  assert.equal(d1.body.data.status, '已完成')
  const d2 = await admin.post('/ops/deadlines/1/complete')
  assert.equal(d2.body.data.status, '已完成')
  assert.equal(d1.body.data.completed_at, d2.body.data.completed_at)
  const f1 = await admin.post('/ops/fees/1/pay')
  assert.equal(f1.body.data.status, '已缴')
  const f2 = await admin.post('/ops/fees/1/pay')
  assert.equal(f2.body.data.status, '已缴')
  assert.equal(f1.body.data.paid_at, f2.body.data.paid_at)
})

test('dashboard 缓存随写操作失效', async () => {
  const admin = api(base, tokens.admin)
  const before1 = (await admin.get('/dashboard')).body.data.kpi.active_cases
  await admin.post('/cases', { client_uuid: 'it-cache-0001', client_id: 1, title: '缓存失效验证案件' })
  const after1 = (await admin.get('/dashboard')).body.data.kpi.active_cases
  assert.equal(after1, before1 + 1)
})
