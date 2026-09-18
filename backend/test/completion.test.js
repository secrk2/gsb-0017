import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stageCompletion, docCompletion, KEY_STAGES } from '../src/lib/completion.js'
import { DOC_STATUS } from '../src/lib/docStatus.js'

test('关键阶段：发明 5 阶段，按历史到达状态计分，分母固定', () => {
  const r = stageCompletion('发明', ['委托中', '已立项', '申请', '受理', '初审', '实审中'])
  assert.deepEqual({ done: r.done, total: r.total }, { done: 4, total: 5 })
  assert.equal(r.percent, 80)
})

test('关键阶段：实用新型 4 阶段（无实审）', () => {
  const r = stageCompletion('实用新型', ['委托中', '已立项', '申请', '受理', '初审'])
  assert.deepEqual({ done: r.done, total: r.total }, { done: 3, total: 4 })
  assert.equal(r.percent, 75)
})

test('关键阶段：驳回后提起复审不丢前期进度（回退不扣已达阶段）', () => {
  const before = stageCompletion('发明', ['委托中', '已立项', '申请', '受理', '初审', '实审中'])
  const afterReject = stageCompletion('发明', ['委托中', '已立项', '申请', '受理', '初审', '实审中', '驳回'])
  assert.equal(before.done, afterReject.done)
  const granted = stageCompletion('发明', ['委托中', '已立项', '申请', '受理', '初审', '实审中', '驳回', '复审中', '授权'])
  assert.equal(granted.done, 5)
  assert.equal(granted.percent, 100)
})

test('关键阶段：无任何历史时为 0%，未知类型按发明兜底', () => {
  assert.equal(stageCompletion('发明', []).percent, 0)
  assert.equal(stageCompletion(undefined, ['申请']).total, KEY_STAGES['发明'].length)
})

test('官文归档：只登记未归档（半截官文）越多，归档口径越低', () => {
  const docs = [
    { status: DOC_STATUS.ARCHIVED }, { status: DOC_STATUS.ARCHIVED },
    { status: DOC_STATUS.REGISTERED }, { status: DOC_STATUS.REGISTERED },
  ]
  const r = docCompletion(docs)
  assert.deepEqual({ done: r.done, total: r.total }, { done: 2, total: 4 })
  assert.equal(r.percent, 50)
})

test('官文归档：已撤回计入分母但不计完成（登记后撤回拉低归档完整度）', () => {
  const r = docCompletion([{ status: DOC_STATUS.ARCHIVED }, { status: DOC_STATUS.WITHDRAWN }])
  assert.deepEqual({ done: r.done, total: r.total }, { done: 1, total: 2 })
  assert.equal(r.percent, 50)
})

test('两口径在半截官文案件上方向相反：阶段近完成 vs 归档很低', () => {
  const stage = stageCompletion('发明', ['委托中', '已立项', '申请', '受理', '初审', '实审中'])
  const doc = docCompletion([{ status: DOC_STATUS.REGISTERED }, { status: DOC_STATUS.REGISTERED }, { status: DOC_STATUS.ARCHIVED }])
  assert.ok(stage.percent >= 80)
  assert.ok(doc.percent <= 40)
})

test('官文归档：无官文时 0/0 → 0%（界面需展示空态而非除以零）', () => {
  const r = docCompletion([])
  assert.deepEqual({ done: r.done, total: r.total, percent: r.percent }, { done: 0, total: 0, percent: 0 })
})
