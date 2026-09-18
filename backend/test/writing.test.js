import { test } from 'node:test'
import assert from 'node:assert/strict'
import { diffContent, threeWayMerge } from '../src/lib/paragraphs.js'
import { maskContent, compilePatterns, DEFAULT_RULES, reconcileClientContent, restorePlaceholders, SENSITIVE_PLACEHOLDER } from '../src/lib/docMask.js'
import { normalizeContent, contentEqual } from '../src/lib/writing.js'

const C = (sections) => ({
  sections: Object.entries(sections).map(([key, paras]) => ({
    key,
    title: key,
    paragraphs: paras.map(([id, text, sensitive]) => ({ id, text, sensitive: !!sensitive })),
  })),
})

test('diff：新增/删除/修改/未变四类，按段落 id 对齐', () => {
  const base = C({ s: [['p1', '原文一'], ['p2', '原文二']] })
  const target = C({ s: [['p1', '原文一改'], ['p3', '新增三']] })
  const d = diffContent(base, target)
  const byId = Object.fromEntries(d.sections[0].items.map((i) => [i.paragraph_id, i.change]))
  assert.equal(byId.p1, 'modified')
  assert.equal(byId.p2, 'removed')
  assert.equal(byId.p3, 'added')
  assert.equal(d.changed, 3)
})

test('三路合并：只一方改的段落自动合入，双方都没动保持', () => {
  const B = C({ s: [['p1', '共同'], ['p2', '共同二']] })
  const H = C({ s: [['p1', '代理人改了'], ['p2', '共同二']] })
  const P = C({ s: [['p1', '共同'], ['p2', '客户改了']] })
  const r = threeWayMerge(B, H, P)
  assert.equal(r.conflicts.length, 0)
  const m = r.merged.sections[0].paragraphs
  assert.equal(m.find((p) => p.id === 'p1').text, '代理人改了')
  assert.equal(m.find((p) => p.id === 'p2').text, '客户改了')
})

test('三路合并：双方改同一段且不一致 → 段落级冲突，双方文本都带回，不静默覆盖', () => {
  const B = C({ s: [['p1', '原始']] })
  const H = C({ s: [['p1', '先来者版本']] })
  const P = C({ s: [['p1', '后来者版本']] })
  const r = threeWayMerge(B, H, P, { incomingActorName: '代理人', pendingActorName: '客户' })
  assert.equal(r.conflicts.length, 1)
  const cf = r.conflicts[0]
  assert.equal(cf.paragraph_id, 'p1')
  assert.equal(cf.incoming_text, '先来者版本')
  assert.equal(cf.pending_text, '后来者版本')
  assert.equal(cf.base_text, '原始')
  assert.equal(cf.incoming_actor_name, '代理人')
})

test('三路合并：一方编辑、另一方删除同一段 → 也是冲突（不许删除静默吃掉编辑）', () => {
  const B = C({ s: [['p1', '原始']] })
  const H = C({ s: [] }) // 先来者删了
  const P = C({ s: [['p1', '后来者编辑']] })
  const r = threeWayMerge(B, H, P)
  assert.equal(r.conflicts.length, 1)
  assert.equal(r.conflicts[0].incoming_deleted, true)
  assert.equal(r.conflicts[0].pending_text, '后来者编辑')
})

test('三路合并：双方各自新增不同段落 → 都保留；新增同文 → 自动合一', () => {
  const B = C({ s: [['p1', 'x']] })
  const H = C({ s: [['p1', 'x'], ['h1', '代理人新增']] })
  const P = C({ s: [['p1', 'x'], ['q1', '客户新增']] })
  const r = threeWayMerge(B, H, P)
  assert.equal(r.conflicts.length, 0)
  const ids = r.merged.sections[0].paragraphs.map((p) => p.id)
  assert.deepEqual(ids.sort(), ['h1', 'p1', 'q1'])

  const same = threeWayMerge(B, C({ s: [['p1', 'x'], ['n1', '相同新增']] }), C({ s: [['p1', 'x'], ['n1', '相同新增']] }))
  assert.equal(same.conflicts.length, 0)
  assert.equal(same.merged.sections[0].paragraphs.filter((p) => p.id === 'n1').length, 1)
})

test('脱敏：参数/文献号按规则句内遮蔽；在先引用整章隐藏；sensitive 段整段隐藏', () => {
  const content = C({
    solution: [['p1', '在 85℃ 与 62% 孔隙率下焊接，参见 CN 114123456 A。'], ['p2', '普通段落不应遮蔽']],
    prior_refs: [['pr1', '《某论文》(2019) 与 WO 2021123456 A1']],
  })
  const out = maskContent(content, { version: 1, ...DEFAULT_RULES })
  const sol = out.sections.find((s) => s.key === 'solution')
  assert.match(sol.paragraphs[0].text, /【温度参数】/)
  assert.match(sol.paragraphs[0].text, /【配比参数】/)
  assert.match(sol.paragraphs[0].text, /【在先专利文献】/)
  assert.equal(sol.paragraphs[1].masked, false)
  const refs = out.sections.find((s) => s.key === 'prior_refs')
  assert.equal(refs.hidden, true)
  assert.equal(refs.paragraphs.length, 0)

  const withSensitive = C({ solution: [['p3', '机密配方', true]] })
  const out2 = maskContent(withSensitive, { version: 1, ...DEFAULT_RULES })
  assert.equal(out2.sections[0].paragraphs[0].masked, true)
  assert.match(out2.sections[0].paragraphs[0].text, /已按撰稿脱敏规则隐藏/)
})

test('脱敏快照不变性：同一历史内容用 v1/v2 两版规则分别渲染，结果互不影响', () => {
  const content = C({ solution: [['p1', '温度 85℃，产线编号 HX-77A 不被 v1 遮蔽']] })
  const v1 = { version: 1, ...DEFAULT_RULES }
  const v2 = {
    version: 2,
    hideSections: [],
    hideSensitiveParagraphs: true,
    patterns: [
      ...DEFAULT_RULES.patterns,
      { id: 'new_code', name: '新代号', regex: 'HX-\\d+[A-Z]?', replacement: '【新代号】', flags: 'g' },
    ],
  }
  const old = maskContent(content, v1)
  const now = maskContent(content, v2)
  assert.doesNotMatch(old.sections[0].paragraphs[0].text, /【新代号】/)
  assert.match(now.sections[0].paragraphs[0].text, /【新代号】/)
  // 已发出的 v1 渲染结果不随规则升级改变
  assert.equal(old.mask_rule_version, 1)
  assert.equal(now.mask_rule_version, 2)
})

test('compilePatterns：非法正则跳过，不炸全量脱敏', () => {
  const ps = compilePatterns({ patterns: [{ id: 'bad', regex: '([', replacement: 'x' }, { id: 'ok', regex: '\\d+℃', replacement: '【温】' }] })
  assert.equal(ps.length, 1)
})

test('normalizeContent：按类型章节定义补齐空章节，新段落补 id，去空白段', () => {
  const n = normalizeContent('disclosure', { sections: [{ key: 'solution', paragraphs: [{ text: '  有内容  ' }, { text: '   ' }] }] })
  assert.equal(n.sections.length, 7)
  const sol = n.sections.find((s) => s.key === 'solution')
  assert.equal(sol.paragraphs.length, 1)
  assert.ok(sol.paragraphs[0].id)
  assert.equal(sol.paragraphs[0].text, '有内容')
  const round = normalizeContent('disclosure', n)
  assert.ok(contentEqual(n, round))
})

test('reconcile：客户在脱敏版上没动的遮蔽段保存后仍为原文；隐藏章原样保留；真改的段以客户为准', () => {
  const head = C({
    solution: [['p1', '在 85℃ 焊接'], ['p2', '新增普通段'], ['p3', '绝密配方', true]],
    prior_refs: [['pr1', 'CN 114123456 A 在先文献']],
  })
  const masked = maskContent(head, { version: 1, ...DEFAULT_RULES })
  // 客户原样回提脱敏视图（没动）
  const submitted = normalizeContent('disclosure', masked)
  const out = reconcileClientContent(head, submitted, { version: 1, ...DEFAULT_RULES })
  const sol = out.sections.find((s) => s.key === 'solution')
  assert.equal(sol.paragraphs.find((p) => p.id === 'p1').text, '在 85℃ 焊接')
  assert.equal(sol.paragraphs.find((p) => p.id === 'p2').text, '新增普通段')
  assert.equal(sol.paragraphs.find((p) => p.id === 'p3').text, '绝密配方')
  const refs = out.sections.find((s) => s.key === 'prior_refs')
  assert.equal(refs.paragraphs[0].text, 'CN 114123456 A 在先文献')

  // 客户真改了 p1（把占位符连同文字一起改成新句）→ 以客户为准，但仍参与协同冲突判定
  const edited = normalizeContent('disclosure', {
    sections: masked.sections.filter((s) => !s.hidden).map((s) => ({
      key: s.key,
      paragraphs: s.paragraphs.map((p) => (p.id === 'p1' ? { id: p.id, text: '改成无参数的新描述' } : p)),
    })),
  })
  const out2 = reconcileClientContent(head, edited, { version: 1, ...DEFAULT_RULES })
  assert.equal(out2.sections.find((s) => s.key === 'solution').paragraphs.find((p) => p.id === 'p1').text, '改成无参数的新描述')
  // 隐藏章仍回填
  assert.equal(out2.sections.find((s) => s.key === 'prior_refs').paragraphs[0].text, 'CN 114123456 A 在先文献')
})

test('reconcile：客户删可见段生效；新增段保留', () => {
  const head = C({ solution: [['p1', '可见一'], ['p2', '可见二']] })
  const submitted = normalizeContent('disclosure', { sections: [{ key: 'solution', paragraphs: [{ id: 'p1', text: '可见一' }] }] })
  const out = reconcileClientContent(head, submitted, { version: 1, ...DEFAULT_RULES })
  assert.equal(out.sections.find((x) => x.key === 'solution').paragraphs.length, 1)
  const submitted2 = normalizeContent('disclosure', { sections: [{ key: 'solution', paragraphs: [{ id: 'p1', text: '可见一' }, { text: '客户新增段' }] }] })
  const out2 = reconcileClientContent(head, submitted2, { version: 1, ...DEFAULT_RULES })
  const sol2 = out2.sections.find((x) => x.key === 'solution')
  assert.equal(sol2.paragraphs.length, 2)
  assert.ok(sol2.paragraphs[1].id)
})

test('restorePlaceholders：手工合并文本里的占位符按候选原文真实值顺序回填', () => {
  const text = '工况取 【温度参数】 至 【温度参数】，参见【在先专利文献】'
  const candidates = ['代理人：60℃ 焊接', '客户：70℃ 附图 CN 114123456 A']
  const out = restorePlaceholders(text, candidates, { version: 1, ...DEFAULT_RULES })
  assert.equal(out, '工况取 60℃ 至 70℃，参见CN 114123456')
})
