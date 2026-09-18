import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { boot, login } from './helpers.js'

let server
let base
const T = {}

async function asUser(username) {
  const token = T[username] || (T[username] = await login(base, username))
  return async (method, path, body, headers = {}) => {
    const r = await fetch(`${base}/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const j = await r.json().catch(() => null)
    return { status: r.status, body: j, headers: r.headers, raw: r }
  }
}

const content = (sections) => ({ sections: Object.entries(sections).map(([key, paras]) => ({ key, paragraphs: paras.map(([id, text]) => ({ id, text })) })) })

before(async () => {
  ;({ server, base } = await boot())
})
after(() => server.close())

test('撰稿总览：无草稿 / 在办 / 全部作废 三态分开', async () => {
  const agent = await asUser('agent01')
  const none = (await agent('GET', '/cases/4/writing')).body.data // 委托中案件，无任何撰稿
  assert.equal(none.kinds.disclosure.state, 'none')
  assert.equal(none.kinds.claims.state, 'none')

  const c1 = (await agent('GET', '/cases/1/writing')).body.data
  assert.equal(c1.kinds.disclosure.state, 'active')
  assert.equal(c1.kinds.disclosure.doc.current_version, 3)
  assert.equal(c1.kinds.specification.doc.status, '已定稿')

  const c8 = (await agent('GET', '/cases/8/writing')).body.data
  assert.equal(c8.kinds.disclosure.state, 'void')
  assert.equal(c8.kinds.disclosure.voided_count, 2)
  assert.equal(c8.kinds.disclosure.voided_docs.length, 2)

  const c5 = (await agent('GET', '/cases/5/writing')).body.data
  assert.equal(c5.kinds.disclosure.state, 'parsing') // 已上传原件仍在解析，正文零版本
  assert.equal(c5.kinds.disclosure.doc.current_version, 0)
})

test('脱敏：代理所见原文，客户见脱敏版（同一条版本链），在先引用章整章隐藏', async () => {
  const agent = await asUser('agent01')
  const client = await asUser('client01')
  const other = await asUser('client02')
  assert.equal((await other('GET', '/cases/1/writing')).status, 403)

  const docA = (await agent('GET', '/writing/docs/1')).body.data
  const headA = docA.head
  const solA = headA.content.sections.find((s) => s.key === 'solution').paragraphs[0].text
  assert.match(solA, /60℃/)
  assert.equal(headA.masked, false)

  const docC = (await client('GET', '/writing/docs/1')).body.data
  assert.equal(docC.head.masked, true)
  const solC = docC.head.content.sections.find((s) => s.key === 'solution').paragraphs[0].text
  assert.match(solC, /【温度参数】/)
  assert.doesNotMatch(solC, /60℃/)
  const refs = docC.head.content.sections.find((s) => s.key === 'prior_refs')
  assert.equal(refs.hidden, true)
  assert.equal(refs.paragraphs.length, 0)
  assert.ok(docC.head.mask_rule_version >= 1)
})

test('版本差异：两版 diff 有增改，客户侧拿到的是脱敏差异', async () => {
  const agent = await asUser('agent01')
  const client = await asUser('client01')
  const d = (await agent('GET', '/writing/docs/1/diff?from=1&to=3')).body.data
  assert.ok(d.changed >= 1)
  assert.equal(d.masked, false)
  const dc = (await client('GET', '/writing/docs/1/diff?from=1&to=3')).body.data
  assert.equal(dc.masked, true)
  const sol = dc.sections.find((s) => s.key === 'solution')
  assert.ok(sol.items.some((i) => /【温度参数】/.test(i.target_text)))
})

test('协同：同一段两人先后改 → 409 段落级冲突，不覆盖不拒绝，取舍后生成合并版本', async () => {
  const client = await asUser('client01')
  const agent = await asUser('agent01')
  // 案件 3（华芯，受理阶段）新建交底链
  const created = await client('POST', '/cases/3/writing/disclosure', { title: '探针卡交底-冲突测试' })
  assert.equal(created.status, 201)
  const docId = created.body.data.id

  const v1 = await client('POST', '/cases/3/writing/disclosure/save', {
    content: content({ solution: [['s1', '客户原文：工况 85℃']] }),
    summary: '客户初稿',
  })
  assert.equal(v1.status, 201)
  assert.equal(v1.body.data.version_no, 1)

  // 未带 base_version_id → 明确要求带基线，而不是默默覆盖
  const noBase = await client('POST', '/cases/3/writing/disclosure/save', { content: content({ solution: [['s1', 'x']] }) })
  assert.equal(noBase.status, 409)
  assert.equal(noBase.body.error.code, 'BASE_REQUIRED')

  // 代理人基于 v1 先保存 v2
  const v2 = await agent('POST', '/cases/3/writing/disclosure/save', {
    base_version_id: v1.body.data.version_id,
    content: content({ solution: [['s1', '代理人改写：工况 60℃，增加焊接']] }),
    summary: '代理人修改',
  })
  assert.equal(v2.status, 201)
  assert.equal(v2.body.data.version_no, 2)

  // 客户仍基于 v1 保存同段 → 冲突
  const conflict = await client('POST', '/cases/3/writing/disclosure/save', {
    base_version_id: v1.body.data.version_id,
    content: content({ solution: [['s1', '客户改写：工况 70℃，补充附图']] }),
    summary: '客户修改',
  })
  assert.equal(conflict.status, 409)
  assert.equal(conflict.body.error.code, 'PARAGRAPH_CONFLICT')
  const det = conflict.body.error.details
  assert.equal(det.masked, true)
  assert.equal(det.conflicts.length, 1)
  // 客户侧冲突弹窗看到的是按版本快照脱敏的文本，不见原始参数，但谁改的仍明示
  assert.equal(det.conflicts[0].incoming_text, '代理人改写：工况 【温度参数】，增加焊接')
  assert.equal(det.conflicts[0].pending_text, '客户改写：工况 【温度参数】，补充附图')
  assert.equal(det.conflicts[0].incoming_actor_name, '李慕华')
  assert.equal(det.conflicts[0].pending_actor_name, '王工')

  // 冲突期间链头没有前进（后来者改动没有落链，也没有覆盖对方）
  const during = (await agent('GET', `/writing/docs/${docId}`)).body.data
  assert.equal(during.current_version, 2)
  assert.equal(during.conflicts.length, 1)

  // 客户逐段取舍：合并文本
  const resolve = await client('POST', `/writing/docs/${docId}/conflicts/resolve`, {
    pending_content: det.pending_content,
    resolutions: [{ conflict_id: det.conflicts[0].id, choice: 'merged', text: '合并稿：工况 60℃~70℃，焊接并补充附图' }],
  })
  assert.equal(resolve.status, 201, JSON.stringify(resolve.body))
  assert.equal(resolve.body.data.save_type, '冲突合并')
  assert.equal(resolve.body.data.version_no, 3)

  const after = (await client('GET', `/writing/docs/${docId}`)).body.data
  assert.equal(after.conflicts.length, 0)
  const text = after.head.content.sections.find((s) => s.key === 'solution').paragraphs[0].text
  assert.match(text, /合并稿/)
})

test('客户在脱敏版上保存：未动的遮蔽段与隐藏章不被破坏，真改的段落才落客户文本', async () => {
  const client = await asUser('client01')
  const agent = await asUser('agent01')
  // 种子 1 号案交底书 v3 链头：含温度参数与 prior_refs 隐藏章
  const docC = (await client('GET', '/writing/docs/1')).body.data
  const headNo = docC.current_version
  const maskedHead = docC.head.content
  const solBefore = maskedHead.sections.find((x) => x.key === 'solution').paragraphs[0].text
  assert.match(solBefore, /【温度参数】/)
  assert.equal(maskedHead.sections.find((x) => x.key === 'prior_refs').hidden, true)

  // 客户原样回提脱敏视图，仅改一个无参数的普通段落
  const payload = {
    sections: maskedHead.sections
      .filter((x) => !x.hidden)
      .map((x) => ({ key: x.key, paragraphs: x.paragraphs.map((pa) => ({ id: pa.id, text: pa.text })) })),
  }
  payload.sections.find((x) => x.key === 'effect').paragraphs[0].text = '相同功耗下结温降低约 12℃（客户更新实测口径）。'
  const saved = await client('POST', '/cases/1/writing/disclosure/save', {
    base_version_id: docC.head.id, content: payload, summary: '客户在脱敏版上更新有益效果',
  })
  assert.equal(saved.status, 201, JSON.stringify(saved.body))
  assert.equal(saved.body.data.version_no, headNo + 1)

  // 代理所见：温度原文仍在、在先引用章完整保留、客户改动生效
  const docA = (await agent('GET', '/writing/docs/1')).body.data
  const solA = docA.head.content.sections.find((x) => x.key === 'solution').paragraphs[0].text
  assert.match(solA, /60℃/, '温度原文不应被占位符固化')
  assert.doesNotMatch(solA, /【温度参数】/)
  const refs = docA.head.content.sections.find((x) => x.key === 'prior_refs')
  assert.ok(refs.paragraphs[0].text.includes('CN 114123456'))
  const eff = docA.head.content.sections.find((x) => x.key === 'effect').paragraphs[0].text
  assert.match(eff, /客户更新实测口径/)
})

test('权限：客户不能改权利要求/说明书；越客户 403', async () => {
  const client = await asUser('client01')
  const other = await asUser('client03')
  const r = await client('POST', '/cases/3/writing/claims', { title: 'x' })
  assert.equal(r.status, 403)
  assert.equal((await other('GET', '/writing/docs/2')).status, 403) // 权要草稿属于华芯案
})

test('作废与回到历史版本重开：作废链留痕，重开产生分支首版并可继续保存', async () => {
  const agent = await asUser('agent01')
  // 案件 8 已有两条作废链，取其一的 v1 重开
  const voidDoc = (await agent('GET', '/cases/8/writing')).body.data.kinds.disclosure.voided_docs[0]
  const detail = (await agent('GET', `/writing/docs/${voidDoc.id}`)).body.data
  const v1 = detail.versions.find((v) => v.version_no === 1)
  const restarted = await agent('POST', '/cases/8/writing/disclosure/restart', { version_id: v1.id })
  assert.equal(restarted.status, 201, JSON.stringify(restarted.body))
  const newId = restarted.body.data.id
  const nd = (await agent('GET', `/writing/docs/${newId}`)).body.data
  assert.equal(nd.status, '草稿中')
  assert.equal(nd.versions[0].branch_from_version_id, v1.id)
  assert.match(nd.versions[0].summary, /重开/)
  // 新链上继续保存
  const again = await agent('POST', '/cases/8/writing/disclosure/save', {
    base_version_id: nd.head.id,
    content: { sections: nd.kind_def.sections.map((s) => ({ key: s.key, paragraphs: s.key === 'solution' ? [{ id: 'n1', text: '重开后新写的方案' }] : [] })) },
  })
  assert.equal(again.status, 201)
  assert.equal(again.body.data.version_no, 2)
})

test('附件：两阶段上传、令牌一次性、换版旧版仍可下载、解析状态回填', async () => {
  const agent = await asUser('agent01')
  const init = await agent('POST', '/writing/docs/3/attachments/init', { filename: '定稿附件测试.pdf', content_type: 'application/pdf' })
  assert.equal(init.status, 201)
  const { version_id, upload_token, object_key } = init.body.data
  assert.ok(object_key.includes('/v1_'))

  async function upload(bytes, token) {
    const r = await fetch(`${base}/api/writing/attachments/upload/${version_id}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${T.agent01}`, 'X-Upload-Token': token, 'Content-Type': 'application/pdf' },
      body: Buffer.from(bytes),
    })
    return { status: r.status, body: await r.json().catch(() => null) }
  }
  const noToken = await upload('v1-bytes', 'bad-token')
  assert.equal(noToken.status, 401)
  const up = await upload('v1-bytes-original', upload_token)
  assert.equal(up.status, 201)
  // 令牌一次性：重复上传被拒（且原件不可覆盖）
  const replay = await upload('v1-bytes-tampered', upload_token)
  assert.equal(replay.status, 409)

  // 换版：新 object_key，旧 key 原样保留
  const init2 = await agent('POST', '/writing/docs/3/attachments/init', { attachment_id: init.body.data.attachment_id, filename: '定稿附件测试.pdf' })
  assert.ok(init2.body.data.object_key.includes('/v2_'))
  const up2 = await fetch(`${base}/api/writing/attachments/upload/${init2.body.data.version_id}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${T.agent01}`, 'X-Upload-Token': init2.body.data.upload_token, 'Content-Type': 'application/pdf' },
    body: Buffer.from('v2-bytes-new'),
  })
  assert.equal(up2.status, 201)

  async function download(attId, version) {
    const r = await fetch(`${base}/api/writing/attachments/${attId}/download${version ? `?version=${version}` : ''}`, {
      headers: { Authorization: `Bearer ${T.agent01}` },
    })
    return { status: r.status, text: await r.text(), ver: r.headers.get('X-Attachment-Version') }
  }
  const old = await download(init.body.data.attachment_id, 1)
  assert.equal(old.status, 200)
  assert.equal(old.text, 'v1-bytes-original')
  assert.equal(old.ver, '1')
  const cur = await download(init.body.data.attachment_id, 2)
  assert.equal(cur.text, 'v2-bytes-new')

  // 新上传版本处于解析中 → 回填完成
  const parsed = await agent('POST', `/writing/attachments/versions/${init2.body.data.version_id}/parsed`, { status: '已完成', parse_note: 'OCR 完成' })
  assert.equal(parsed.body.data.status, '已完成')

  // 种子附件：交底书旧版原件仍打得开；说明书附件客户不可下载
  const seededOld = await download(1, 1)
  assert.equal(seededOld.status, 200)
  assert.match(seededOld.text, /v1/)
  const client = await asUser('client01')
  const rDenied = await fetch(`${base}/api/writing/attachments/2/download`, { headers: { Authorization: `Bearer ${T.client01}` } })
  assert.equal(rDenied.status, 403)
  void client
})

test('定稿期限联动：沿用官文起算/天数口径，逾期二次确认留痕', async () => {
  const agent = await asUser('agent01')
  // 案件 3 新建权要草稿并保存一版
  const created = await agent('POST', '/cases/3/writing/claims', { title: '探针卡权要-期限测试' })
  const docId = created.body.data.id
  const v1 = await agent('POST', '/cases/3/writing/claims/save', { content: content({ independent: [['c1', '1. 一种测试探针卡……']] }) })

  // 预览：界面明示以谁为准
  const preview = await agent('POST', '/cases/3/writing/claims/final-deadline-preview', {
    deadline: { dtype: '定稿提交', anchor: 'dispatch', dispatch_date: '2026-09-10', day_basis: 'natural', duration_days: 30 },
  })
  assert.equal(preview.status, 200)
  assert.equal(preview.body.data.start_date, '2026-09-10')
  assert.equal(preview.body.data.due_date, '2026-10-10')
  assert.match(preview.body.data.start_kind, /发文日/)

  // 逾期定稿：先 409 预览，再 400 要原因，最后带确认+原因通过
  const overdue = await agent('POST', '/cases/3/writing/claims/save', {
    base_version_id: v1.body.data.version_id,
    finalize: true,
    content: content({ independent: [['c1', '1. 一种测试探针卡……']] }),
    deadline: { anchor: 'dispatch', dispatch_date: '2026-08-01', day_basis: 'natural', duration_days: 10 },
  })
  assert.equal(overdue.status, 409)
  assert.equal(overdue.body.error.code, 'OVERDUE_CONFIRM')
  const noReason = await agent('POST', '/cases/3/writing/claims/save', {
    base_version_id: v1.body.data.version_id, finalize: true, confirm_overdue: true,
    content: content({ independent: [['c1', '1. 一种测试探针卡……']] }),
    deadline: { anchor: 'dispatch', dispatch_date: '2026-08-01', day_basis: 'natural', duration_days: 10 },
  })
  assert.equal(noReason.status, 400)
  assert.equal(noReason.body.error.code, 'OVERDUE_REASON_REQUIRED')
  const ok = await agent('POST', '/cases/3/writing/claims/save', {
    base_version_id: v1.body.data.version_id, finalize: true, confirm_overdue: true, overdue_reason: '客户确认签章延误，已加急提交',
    content: content({ independent: [['c1', '1. 一种测试探针卡，其特征在于弹性探针呈阵列布置（定稿版）。']] }),
    deadline: { anchor: 'dispatch', dispatch_date: '2026-08-01', day_basis: 'natural', duration_days: 10 },
  })
  assert.equal(ok.status, 201, JSON.stringify(ok.body))
  assert.equal(ok.body.data.status, '已定稿')
  assert.equal(ok.body.data.deadline.due_date, '2026-08-11')

  // 案件详情期限列表能看到联动期限
  const detail = (await agent('GET', '/cases/3')).body.data
  assert.ok(detail.deadlines.some((d) => d.dtype === '定稿提交' && d.overdue_reason))
  void docId
})

test('脱敏规则版本化：新发 v2 规则不改写历史版本，只对之后保存的版本生效', async () => {
  const admin = await asUser('admin')
  const agent = await asUser('agent01')
  const client = await asUser('client01')
  // 案件 3 交底链（冲突测试稿）当前最新版由 v1 规则快照渲染
  const overview = (await agent('GET', '/cases/3/writing')).body.data
  const disclosureId = overview.kinds.disclosure.doc.id
  const before = (await client('GET', `/writing/docs/${disclosureId}`)).body.data
  const beforeText = before.head.content.sections.find((s) => s.key === 'solution').paragraphs[0].text
  assert.equal(before.head.mask_rule_version, 1)

  const rules = (await admin('GET', '/writing/mask-rules')).body.data
  const published = await admin('POST', '/writing/mask-rules', {
    note: '新增内部代号遮蔽（测试 v2）',
    rules: {
      hideSections: rules.rules.hideSections,
      hideSensitiveParagraphs: true,
      patterns: [
        ...rules.rules.patterns,
        { id: 'hx_code', name: '华芯项目代号', regex: 'HX-\\d+[A-Z]?', replacement: '【新项目代号】', flags: 'g' },
      ],
    },
  })
  assert.equal(published.status, 201)
  assert.equal(published.body.data.version, 2)

  // 历史版本仍按 v1 快照渲染：即使文本里出现新规则模式也不遮蔽（此处旧文本无该模式，校验版本号不回改）
  const oldAgain = (await client('GET', `/writing/docs/${disclosureId}`)).body.data
  assert.equal(oldAgain.head.mask_rule_version, 1)
  assert.equal(oldAgain.head.content.sections.find((s) => s.key === 'solution').paragraphs[0].text, beforeText)

  // 保存新版本（含新代号）后按 v2 快照脱敏
  const saved = await agent('POST', '/cases/3/writing/disclosure/save', {
    base_version_id: before.head.id,
    content: content({ solution: [['s1', '合并稿：工况 60℃~70℃，焊接并补充附图'], ['s2', '对应产线编号 HX-77A 的工艺窗口。']] }),
  })
  assert.equal(saved.status, 201)
  const now2 = (await client('GET', `/writing/docs/${disclosureId}`)).body.data
  assert.equal(now2.head.mask_rule_version, 2)
  const s2 = now2.head.content.sections.find((s) => s.key === 'solution').paragraphs.find((p) => p.id === 's2').text
  assert.match(s2, /【新项目代号】/)
  assert.doesNotMatch(s2, /HX-77A/)
})

test('种子：说明书定稿联动期限与附件解析中状态齐备', async () => {
  const agent = await asUser('agent01')
  const c1 = (await agent('GET', '/cases/1')).body.data
  const dl = c1.deadlines.find((d) => d.dtype === '定稿提交')
  assert.ok(dl, '定稿提交期限已联动生成')
  assert.equal(dl.anchor_basis, 'receive')
  assert.equal(dl.day_basis, 'legal')
  assert.ok(dl.due_date > '2026-01-01')

  const c5doc = (await agent('GET', '/writing/docs/6')).body.data
  const parsing = c5doc.attachments[0].versions.find((v) => v.status === '解析中')
  assert.ok(parsing, '附件存在解析中版本')
  // 解析中版本的原件可下载，但状态提示仍在解析
  assert.equal(c5doc.attachments[0].versions.length, 1)
})
