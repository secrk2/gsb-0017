import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkTransition, allowedTransitionsFor, ACTIVE_STATUSES } from '../src/lib/stateMachine.js'

const base = { role: 'admin', isAssignee: false, hasContract: true, hasAgent: true, ctype: '发明' }

test('发明完整链路：委托中→已立项→申请→受理→初审→实审中→授权', () => {
  const chain = ['委托中', '已立项', '申请', '受理', '初审', '实审中', '授权']
  for (let i = 0; i < chain.length - 1; i++) {
    const r = checkTransition({ ...base, from: chain[i], to: chain[i + 1] })
    assert.equal(r.ok, true, `${chain[i]}→${chain[i + 1]} 应合法：${r.message || ''}`)
  }
})

test('实用新型/外观设计初审合格可直接授权，发明不行', () => {
  const util = checkTransition({ ...base, ctype: '实用新型', from: '初审', to: '授权' })
  assert.equal(util.ok, true)
  const design = checkTransition({ ...base, ctype: '外观设计', from: '初审', to: '授权' })
  assert.equal(design.ok, true)
  const inv = checkTransition({ ...base, ctype: '发明', from: '初审', to: '授权' })
  assert.equal(inv.ok, false)
  assert.equal(inv.code, 'CTYPE_PATH_MISMATCH')
  // 发明必须经实审：初审→实审中合法
  assert.equal(checkTransition({ ...base, from: '初审', to: '实审中' }).ok, true)
})

test('法定回退显式合法：驳回→复审中→发回实审/初审', () => {
  assert.equal(checkTransition({ ...base, role: 'agent', isAssignee: true, from: '驳回', to: '复审中' }).ok, true)
  const backExam = checkTransition({ ...base, role: 'reviewer', from: '复审中', to: '实审中' })
  assert.equal(backExam.ok, true)
  const backPrelim = checkTransition({ ...base, role: 'reviewer', from: '复审中', to: '初审' })
  assert.equal(backPrelim.ok, true)
  assert.equal(checkTransition({ ...base, role: 'reviewer', from: '复审中', to: '授权' }).ok, true)
  assert.equal(checkTransition({ ...base, role: 'reviewer', from: '复审中', to: '驳回' }).ok, true)
})

test('非法回退被拦截且说明原因（图中不存在的后退边）', () => {
  const r = checkTransition({ ...base, from: '实审中', to: '受理' })
  assert.equal(r.ok, false)
  assert.equal(r.http, 409)
  assert.equal(r.code, 'ILLEGAL_ROLLBACK')
  assert.match(r.message, /非法回退/)
  assert.match(r.message, /复审程序/)
})

test('跳步被拦截并提示下一步', () => {
  const r = checkTransition({ ...base, from: '委托中', to: '实审中' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'ILLEGAL_TRANSITION')
  assert.match(r.message, /已立项/)
  const r2 = checkTransition({ ...base, from: '受理', to: '实审中' })
  assert.equal(r2.code, 'ILLEGAL_TRANSITION')
  assert.match(r2.message, /初审/)
})

test('同状态为幂等空操作', () => {
  const r = checkTransition({ ...base, from: '实审中', to: '实审中' })
  assert.equal(r.ok, true)
  assert.equal(r.noop, true)
})

test('立项前置条件：未签合同 / 未派代理人', () => {
  const noContract = checkTransition({ ...base, from: '委托中', to: '已立项', hasContract: false })
  assert.equal(noContract.code, 'NO_CONTRACT')
  assert.match(noContract.message, /委托合同/)
  const noAgent = checkTransition({ ...base, from: '委托中', to: '已立项', hasAgent: false })
  assert.equal(noAgent.code, 'NO_AGENT')
})

test('角色权限：代理人不能登记授权/驳回，审核员可以；申请/受理类可登记', () => {
  const agent = checkTransition({ ...base, role: 'agent', isAssignee: true, from: '实审中', to: '授权' })
  assert.equal(agent.code, 'ROLE_DENIED')
  assert.equal(checkTransition({ ...base, role: 'reviewer', from: '实审中', to: '授权' }).ok, true)
  assert.equal(checkTransition({ ...base, role: 'agent', isAssignee: true, from: '申请', to: '受理' }).ok, true)
})

test('代理人只能操作名下案件', () => {
  const r = checkTransition({ ...base, role: 'agent', isAssignee: false, from: '已立项', to: '申请' })
  assert.equal(r.code, 'NOT_ASSIGNEE')
})

test('客户管理员无任何流转权限', () => {
  const r = checkTransition({ ...base, role: 'client_admin', from: '已立项', to: '申请' })
  assert.equal(r.code, 'ROLE_DENIED')
})

test('无效：授权后可受理无效宣告，无效不可再流转', () => {
  assert.equal(checkTransition({ ...base, from: '授权', to: '无效' }).ok, true)
  assert.deepEqual(allowedTargetsGlobal('无效'), [])
})

function allowedTargetsGlobal(s) {
  // allowedTargets 未导出，用 allowedTransitionsFor(admin) 等价验证
  return allowedTransitionsFor(s, 'admin', false, '发明').map((t) => t.to)
}

test('allowedTransitionsFor 按角色与案件类型过滤', () => {
  const adminExam = allowedTransitionsFor('实审中', 'admin', false, '发明').map((t) => t.to)
  assert.deepEqual(adminExam.sort(), ['授权', '驳回'])
  const agentExam = allowedTransitionsFor('实审中', 'agent', true, '发明')
  assert.deepEqual(agentExam, [])
  const utilPrelim = allowedTransitionsFor('初审', 'admin', false, '实用新型').map((t) => t.to)
  assert.deepEqual(utilPrelim.sort(), ['授权', '驳回'])
  const invPrelim = allowedTransitionsFor('初审', 'admin', false, '发明').map((t) => t.to)
  assert.deepEqual(invPrelim.sort(), ['实审中', '驳回'])
  assert.deepEqual(allowedTransitionsFor('授权', 'admin', false, '发明').map((t) => t.to), ['无效'])
})

test('ACTIVE_STATUSES 覆盖全部在办态且不含终态', () => {
  for (const s of ['委托中', '已立项', '申请', '受理', '初审', '实审中', '复审中']) assert.ok(ACTIVE_STATUSES.includes(s))
  for (const s of ['授权', '驳回', '无效']) assert.ok(!ACTIVE_STATUSES.includes(s))
})
