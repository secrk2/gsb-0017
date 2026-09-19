import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_RULES, normRules, validateRules, maskParas, maskLineText, TAG_SECRET, TAG_CITATION,
} from '../src/lib/draftMask.js'

const paras = [
  { key: 'plain', text: '本装置包括壳体与盖板。', tags: [] },
  { key: 'sec', text: '刻蚀液配比采用配方比例：硝酸与磷酸 3:7，催化剂X 用量 0.2%。', tags: ['secret'] },
  { key: 'cite', text: '参见在先 CN115842100A 与 ZL2020101234567。', tags: ['citation'] },
  { key: 'inline', text: '与 CN111222333A 的区别是改用催化剂X。', tags: [] },
]

test('整段遮蔽：secret/citation 段换成占位说明，标记被剥离', () => {
  const { paras: out, stats } = maskParas(paras, DEFAULT_RULES)
  const m = Object.fromEntries(out.map((p) => [p.key, p]))
  assert.match(m.sec.text, /未公开技术细节/)
  assert.equal(m.sec.tags.length, 0)
  assert.equal(m.sec.masked, true)
  assert.match(m.cite.text, /在先引用/)
  assert.equal(stats.redacted_blocks, 2)
})

test('行内替换：未标 secret/citation 的明文段也会替换知号/关键词', () => {
  const { paras: out } = maskParas(paras, DEFAULT_RULES)
  const m = Object.fromEntries(out.map((p) => [p.key, p]))
  assert.ok(!m.inline.text.includes('CN111222333A'))
  assert.ok(!m.inline.text.includes('催化剂X'))
  assert.match(m.inline.text, /在先专利申请|已脱敏/)
  assert.equal(m.plain.masked, false)
})

test('脱敏不改段落 key 与顺序', () => {
  const { paras: out } = maskParas(paras, DEFAULT_RULES)
  assert.deepEqual(out.map((p) => p.key), ['plain', 'sec', 'cite', 'inline'])
})

test('maskLineText：服务端对账用同一口径', () => {
  const s = maskLineText('配比涉及催化剂X，公开号 CN9988776655443A', DEFAULT_RULES)
  assert.ok(!s.includes('催化剂X'))
  assert.ok(!s.includes('CN9988776655443A'))
})

test('规则校验：非法正则被拒绝；默认规则合法', () => {
  assert.equal(validateRules(DEFAULT_RULES).ok, true)
  const bad = validateRules({ ...normRules(DEFAULT_RULES), patterns: [{ name: 'x', regex: '([a-z', flags: 'g' }] })
  assert.equal(bad.ok, false)
  assert.match(bad.error, /不合法/)
})

test('规则调整后：同一段落按新规则得到新快照——但旧快照已固化在版本行，不回溯（由存储层保证）', () => {
  const p = [{ key: 'a', text: '采用新代号 Omega-7 与配方比例。', tags: [] }]
  const v1 = maskParas(p, DEFAULT_RULES)
  const v2Rules = { ...normRules(DEFAULT_RULES), keywords: ['Omega-7', '配方比例'] }
  const v2 = maskParas(p, v2Rules)
  assert.ok(v1.paras[0].text.includes('Omega-7'))
  assert.ok(!v2.paras[0].text.includes('Omega-7'))
  // 旧对象不被再次计算，模拟「历史版本内容不跟着变」
  assert.ok(v1.paras[0].text !== v2.paras[0].text)
  assert.equal(TAG_SECRET, 'secret')
  assert.equal(TAG_CITATION, 'citation')
})
