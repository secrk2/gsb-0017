import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeParas, mergeParas, resolveConflicts, diffParas, diffSummary, parasToContent,
} from '../src/lib/paragraphs.js'

const P = (key, text, tags = []) => ({ key, text, tags })

test('normalizeParas：去空白段、字符串段转结构、tags 去重排序', () => {
  const out = normalizeParas(['第一段', '', '  ', { text: ' 第二段 ', tags: ['citation', 'secret', 'secret'] }])
  assert.equal(out.length, 2)
  assert.equal(out[0].text, '第一段')
  assert.deepEqual(out[1].tags, ['citation', 'secret'])
})

test('首次保存（无父版本）：全部为新增，无冲突', () => {
  const mine = [P('a', '甲'), P('b', '乙')]
  const r = mergeParas(null, mine, [])
  assert.equal(r.conflicts.length, 0)
  assert.deepEqual(r.paras.map((p) => p.key), ['a', 'b'])
})

test('只有对方改：自动并入，后保存者拿到对方改动', () => {
  const base = [P('a', '甲'), P('b', '乙')]
  const theirs = [P('a', '甲改'), P('b', '乙')]
  const mine = [P('a', '甲'), P('b', '乙改')]
  const r = mergeParas(base, mine, theirs)
  assert.equal(r.conflicts.length, 0)
  const m = new Map(r.paras.map((p) => [p.key, p.text]))
  assert.equal(m.get('a'), '甲改') // 对方的改动自动并入
  assert.equal(m.get('b'), '乙改') // 自己的改动保留
})

test('同一段双方改成不同内容：段落级冲突，不静默覆盖', () => {
  const base = [P('a', '甲')]
  const r = mergeParas(base, [P('a', '甲-代理人')], [P('a', '甲-客户')])
  assert.equal(r.conflicts.length, 1)
  assert.equal(r.conflicts[0].key, 'a')
  assert.equal(r.conflicts[0].mine.text, '甲-代理人')
  assert.equal(r.conflicts[0].theirs.text, '甲-客户')
  // 冲突段在裁决前不进入结果
  assert.equal(r.paras.length, 0)
})

test('双方改成相同内容：不算冲突', () => {
  const base = [P('a', '甲')]
  const r = mergeParas(base, [P('a', '甲新')], [P('a', '甲新')])
  assert.equal(r.conflicts.length, 0)
  assert.equal(r.paras[0].text, '甲新')
})

test('一方删、另一方改：两个方向都报冲突（删除不能带走别人改动）', () => {
  const base = [P('a', '甲'), P('b', '乙')]
  const r1 = mergeParas(base, [P('a', '甲改'), P('b', '乙')], [P('b', '乙')])
  assert.equal(r1.conflicts[0].key, 'a')
  assert.match(r1.conflicts[0].reason, /对方已删除/)
  const r2 = mergeParas(base, [P('a', '甲')], [P('a', '甲'), P('b', '乙改')])
  assert.equal(r2.conflicts[0].key, 'b')
  assert.match(r2.conflicts[0].reason, /你删除了/)
})

test('双方共删：静默生效，无冲突', () => {
  const base = [P('a', '甲'), P('b', '乙')]
  const r = mergeParas(base, [P('a', '甲')], [P('a', '甲')])
  assert.equal(r.conflicts.length, 0)
  assert.deepEqual(r.paras.map((p) => p.key), ['a'])
})

test('各自新增不同段落：并存，无冲突', () => {
  const base = [P('a', '甲')]
  const r = mergeParas(base, [P('a', '甲'), P('m', '我加的')], [P('a', '甲'), P('t', '他加的')])
  assert.equal(r.conflicts.length, 0)
  assert.deepEqual(r.paras.map((p) => p.key), ['a', 't', 'm']) // 以对方版本为骨架，新增追加在后
})

test('resolveConflicts：未全部裁决给出 unresolved；mine/theirs/custom 三种取舍', () => {
  const merged = mergeParas([P('a', '0')], [P('a', 'M')], [P('a', 'T')])
  assert.deepEqual(resolveConflicts(merged, []).unresolved, ['a'])
  const mine = resolveConflicts(merged, [{ key: 'a', choice: 'mine' }])
  assert.equal(mine.resolved[0].text, 'M')
  const theirs = resolveConflicts(merged, [{ key: 'a', choice: 'theirs' }])
  assert.equal(theirs.resolved[0].text, 'T')
  const custom = resolveConflicts(merged, [{ key: 'a', choice: 'custom', text: '折中写法' }])
  assert.equal(custom.resolved[0].text, '折中写法')
  assert.equal(custom.unresolved.length, 0)
})

test('diffParas：added/removed/changed/same 四类与统计', () => {
  const from = [P('a', '甲'), P('b', '乙'), P('g', '将删')]
  const to = [P('a', '甲改'), P('b', '乙'), P('n', '新增')]
  const diff = diffParas(from, to)
  const byKey = Object.fromEntries(diff.map((d) => [d.key, d.status]))
  assert.equal(byKey.a, 'changed')
  assert.equal(byKey.b, 'same')
  assert.equal(byKey.n, 'added')
  assert.equal(byKey.g, 'removed')
  assert.deepEqual(diffSummary(diff), { added: 1, removed: 1, changed: 1, same: 1 })
})

test('parasToContent：段落以空行拼接', () => {
  assert.equal(parasToContent([P('a', '第一段'), P('b', '第二段')]), '第一段\n\n第二段')
})
