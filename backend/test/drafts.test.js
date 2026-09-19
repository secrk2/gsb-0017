import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { boot, login, api } from './helpers.js'
import { DEFAULT_RULES } from '../src/lib/draftMask.js'

let server
let base
const T = {}
const H = () => ({ 'Content-Type': 'application/json' })
const iso = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10)

before(async () => {
  ;({ server, base } = await boot())
  for (const u of ['admin', 'agent01', 'agent02', 'client01', 'client02']) T[u] = await login(base, u)
})
after(() => server.close())

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function draftsOverview(token, caseId) {
  return (await api(base, token).get(`/cases/${caseId}/drafts`)).body.data
}
async function draftDetail(token, caseId, dtype = 'technical_disclosure') {
  return (await api(base, token).get(`/cases/${caseId}/drafts/${dtype}`)).body.data
}
async function save(token, caseId, dtype, body) {
  return api(base, token).post(`/cases/${caseId}/drafts/${dtype}/versions`, body)
}

test('概览：三类文书齐全；种子案件三种空态各不相同', async () => {
  const ov = await draftsOverview(T.admin, 1)
  assert.deepEqual(ov.map((d) => d.dtype).sort(), ['claims', 'specification', 'technical_disclosure'])
  const td = ov.find((d) => d.dtype === 'technical_disclosure')
  assert.equal(td.status, '编辑中')
  assert.equal(td.valid_count, 3)
  assert.equal(td.empty_state, null)

  const c6 = (await draftsOverview(T.admin, 6)).find((d) => d.dtype === 'technical_disclosure')
  assert.equal(c6.exists, false)
  assert.equal(c6.empty_state, 'no_draft') // 还没有草稿

  const c3 = (await draftsOverview(T.admin, 3)).find((d) => d.dtype === 'technical_disclosure')
  assert.equal(c3.empty_state, 'all_void') // 草稿全部作废
  assert.equal(c3.current_version_id, null)

  const c5 = (await draftsOverview(T.admin, 5)).find((d) => d.dtype === 'technical_disclosure')
  assert.equal(c5.empty_state, 'attachment_parsing') // 附件还在解析
})

test('版本链：所内看原文含敏感段；客户看同链脱敏快照（隐去未公开细节与在先引用）', async () => {
  const firm = await draftDetail(T.agent01, 1)
  assert.equal(firm.versions.length, 3)
  assert.equal(firm.current_version.version_no, 3)
  assert.equal(firm.masked || firm.current_version.masked, false)
  const sec = firm.current_version.paras.find((p) => p.key === 'p1-core')
  assert.match(sec.text, /配方比例/)
  assert.deepEqual(sec.tags, ['secret'])
  assert.match(firm.current_version.paras.find((p) => p.key === 'p1-cite').text, /CN115842100A/)

  const cli = await draftDetail(T.client01, 1)
  assert.equal(cli.versions.length, 3) // 同一条版本链
  assert.equal(cli.current_version.masked, true)
  const secM = cli.current_version.paras.find((p) => p.key === 'p1-core')
  assert.match(secM.text, /未公开技术细节/)
  assert.ok(!secM.text.includes('配方比例'))
  const citeM = cli.current_version.paras.find((p) => p.key === 'p1-cite')
  assert.match(citeM.text, /在先引用/)
  assert.ok(!citeM.text.includes('CN115842100A'))
  assert.equal(cli.current_version.mask_rule_version, 1)
})

test('越权：客户改他人案件 403；客户改非交底文书 ROLE_DENIED', async () => {
  const other = await save(T.client01, 8, 'technical_disclosure', { paras: [{ text: '越权' }] })
  assert.equal(other.status, 403)
  const denied = await save(T.client01, 1, 'claims', { paras: [{ text: '1. 某权利要求' }] })
  assert.equal(denied.status, 403)
  assert.equal(denied.body.error.code, 'ROLE_DENIED')
})

test('保存即版本 + parent 约束：首版无 parent，再存必须带 parent_id', async () => {
  const first = await save(T.agent01, 4, 'technical_disclosure', {
    paras: [
      { key: 'a', text: '第一段：探针卡基座。' },
      { key: 'b', text: '核心工艺参数（未公开）', tags: ['secret'] },
      { key: 'c', text: '第三段：测试效果。' },
    ],
    summary: 'v1',
  })
  assert.equal(first.status, 201)
  assert.equal(first.body.data.versionNo, 1)
  const noParent = await save(T.agent01, 4, 'technical_disclosure', { paras: [{ key: 'a', text: 'x' }] })
  assert.equal(noParent.status, 400)
  assert.equal(noParent.body.error.code, 'PARENT_REQUIRED')
})

test('客户回存脱敏版：未改段/锁段一律恢复原文，占位文本绝不写回；tags 不可篡改', async () => {
  const seen = await draftDetail(T.client01, 4)
  assert.equal(seen.current_version.masked, true)
  // 客户把看到的脱敏段落原样回传，仅把明文段 a 改掉
  const paras = seen.current_version.paras.map((p) => ({ key: p.key, text: p.text }))
  paras[0].text = '第一段（客户修订）：探针卡基座与导向套。'
  const r = await save(T.client01, 4, 'technical_disclosure', { paras, parent_id: seen.current_version.id, summary: '客户改明文段' })
  assert.equal(r.status, 201)
  const firm = await draftDetail(T.agent01, 4)
  const byKey = Object.fromEntries(firm.current_version.paras.map((p) => [p.key, p]))
  assert.match(byKey.a.text, /客户修订/)
  assert.match(byKey.b.text, /核心工艺参数/) // 原文仍在，不是脱敏占位
  assert.deepEqual(byKey.b.tags, ['secret'])
})

test('同一段双方改：409 段落级冲突 + 冲突清单，不产生版本；逐段取舍后才保存', async () => {
  const base = await draftDetail(T.agent01, 4)
  const baseId = base.current_version.id
  // 代理人先提交一版（改 a 段）
  const agentEdit = await save(T.agent01, 4, 'technical_disclosure', {
    paras: base.current_version.paras.map((p) => (p.key === 'a' ? { ...p, text: '第一段（代理人改）：探针基座。' } : p)),
    parent_id: baseId, summary: '代理人改',
  })
  assert.equal(agentEdit.status, 201)
  const versionsBefore = (await draftDetail(T.agent01, 4)).versions.length

  // 客户仍基于旧版改同一段 → 冲突
  const conflict = await save(T.client01, 4, 'technical_disclosure', {
    paras: [
      { key: 'a', text: '第一段（客户改）：导向套结构。' },
      { key: 'b', text: '核心工艺参数（未公开）' },
      { key: 'c', text: '第三段：测试效果。' },
    ],
    parent_id: baseId, summary: '客户改',
  })
  assert.equal(conflict.status, 409)
  assert.equal(conflict.body.error.code, 'PARAGRAPH_CONFLICT')
  assert.equal(conflict.body.error.details.conflicts[0].key, 'a')
  assert.match(conflict.body.error.details.conflicts[0].reason, /双方同时修改|双方修改/)
  const versionsAfter = (await draftDetail(T.agent01, 4)).versions.length
  assert.equal(versionsAfter, versionsBefore, '冲突未裁决前不许产生新版本')

  // 不允许「已被锁定」：客户可在同一界面取舍，选择保留自己的写法
  const resolved = await save(T.client01, 4, 'technical_disclosure', {
    paras: [
      { key: 'a', text: '第一段（客户改）：导向套结构。' },
      { key: 'b', text: '核心工艺参数（未公开）' },
      { key: 'c', text: '第三段：测试效果。' },
    ],
    parent_id: baseId,
    resolutions: [{ key: 'a', choice: 'mine' }],
    summary: '客户取舍：a 用客户版',
  })
  assert.equal(resolved.status, 201)
  const final = await draftDetail(T.agent01, 4)
  assert.match(final.current_version.paras.find((p) => p.key === 'a').text, /客户改/)
  assert.equal(final.current_version.merge_resolutions[0].pick, 'mine')
})

test('客户视角的冲突回显：对方段落含敏感词时不回原文（纵深防护，正常不会走到）', async () => {
  // 构造：代理人在明文段里写入敏感词后保存，客户基于旧版改同一段 → 冲突
  const base = await draftDetail(T.agent01, 4)
  const baseId = base.current_version.id
  await save(T.agent01, 4, 'technical_disclosure', {
    paras: base.current_version.paras.map((p) => (p.key === 'c' ? { ...p, text: '第三段：测试效果，关键刻蚀液配比保密。' } : p)),
    parent_id: baseId, summary: '代理人写入含敏感词明文',
  })
  const cf = await save(T.client01, 4, 'technical_disclosure', {
    paras: [
      { key: 'a', text: '第一段（客户修订）：探针卡基座与导向套。' },
      { key: 'b', text: '核心工艺参数（未公开）' },
      { key: 'c', text: '第三段：客户改写。' },
    ],
    parent_id: baseId,
  })
  assert.equal(cf.status, 409)
  const cBlock = cf.body.error.details.conflicts.find((x) => x.key === 'c')
  assert.ok(cBlock, 'c 段应在冲突清单中')
  assert.ok(!cBlock.theirs.text.includes('刻蚀液配比'), '对方原文敏感词必须脱敏后回显')
  assert.match(cBlock.theirs.text, /已脱敏/)
})

test('版本差异：按段落给出 added/changed/removed', async () => {  const d = await draftDetail(T.agent01, 4)
  const ids = d.versions.map((v) => v.id)
  const r = await api(base, T.agent01).get(`/cases/4/drafts/technical_disclosure/diff?from=${ids[0]}&to=${ids[ids.length - 1]}`)
  assert.equal(r.status, 200)
  assert.ok(r.body.data.summary.changed >= 1)
  assert.ok(r.body.data.diff.some((x) => x.key === 'a' && x.status === 'changed'))
})

test('作废需原因留痕；全部作废后 empty_state=all_void；可从已作废历史版本重开', async () => {
  const before = await draftDetail(T.agent01, 3)
  assert.equal(before.empty_state, 'all_void')
  const noReason = await api(base, T.agent01).post('/cases/3/drafts/technical_disclosure/reopen', { from_version_id: before.versions[0].id })
  assert.equal(noReason.status, 201) // 重开本身不强制原因
  const reopened = await draftDetail(T.agent01, 3)
  assert.equal(reopened.empty_state, null)
  assert.equal(reopened.current_version.status, '有效')

  // 再作废：原因不足 2 字 → 400
  const bad = await api(base, T.agent01).post('/cases/3/drafts/technical_disclosure/void', { version_id: reopened.current_version.id, reason: 'x' })
  assert.equal(bad.status, 400)
  assert.equal(bad.body.error.code, 'REASON_REQUIRED')
  const ok = await api(base, T.agent01).post('/cases/3/drafts/technical_disclosure/void', { version_id: reopened.current_version.id, reason: '重开后发现仍需现场复核，再次作废。' })
  assert.equal(ok.status, 200)
  assert.equal((await draftDetail(T.agent01, 3)).empty_state, 'all_void')
})

test('定稿期限：沿用官文口径（自收到日/法定顺延），预览明示起算依据', async () => {
  const mk = await save(T.agent01, 4, 'claims', { paras: [{ key: 'cl1', text: '1. 一种测试探针卡，包括基座与探针，其特征在于……' }], summary: '权要初稿' })
  assert.equal(mk.status, 201)
  const pv = await api(base, T.agent01).post('/cases/4/drafts/claims/finalize-preview', {
    receive_date: iso(-9), anchor: 'receive', day_basis: 'legal', duration_days: 60,
  })
  assert.equal(pv.status, 200)
  assert.equal(pv.body.data.start_kind, '实际收到日')
  assert.match(pv.body.data.anchor_hint, /收到日/)
  assert.match(pv.body.data.due_date, /^\d{4}-\d{2}-\d{2}$/)
  assert.match(pv.body.data.basis_hint, /顺延/)
  assert.equal(pv.body.data.firm_tz, 'Asia/Shanghai')

  const fin = await api(base, T.agent01).post('/cases/4/drafts/claims/finalize', {
    receive_date: iso(-9), anchor: 'receive', day_basis: 'legal', duration_days: 60,
  })
  assert.equal(fin.status, 201)
  assert.ok(fin.body.data.deadline_id)
  const detail = await draftDetail(T.agent01, 4, 'claims')
  assert.equal(detail.status, '已定稿')
  assert.equal(detail.deadline.anchor_basis, 'receive')
  assert.equal(detail.deadline.day_basis, 'legal')
  // 定稿后再改 → 拒绝
  const locked = await save(T.agent01, 4, 'claims', { paras: [{ key: 'cl1', text: '改' }], parent_id: detail.current_version.id })
  assert.equal(locked.status, 409)
  assert.equal(locked.body.error.code, 'DRAFT_FINALIZED')
})

test('定稿落点逾期：先 409 二次确认，再要原因；齐全后留痕落库', async () => {
  await save(T.agent01, 4, 'specification', { paras: [{ key: 'sp1', text: '说明书正文……' }], summary: '初稿' })
  const args = { receive_date: iso(-200), anchor: 'receive', day_basis: 'natural', duration_days: 30 }
  const first = await api(base, T.agent01).post('/cases/4/drafts/specification/finalize', args)
  assert.equal(first.status, 409)
  assert.equal(first.body.error.code, 'OVERDUE_CONFIRM')
  const noReason = await api(base, T.agent01).post('/cases/4/drafts/specification/finalize', { ...args, confirm_overdue: true })
  assert.equal(noReason.status, 400)
  assert.equal(noReason.body.error.code, 'OVERDUE_REASON_REQUIRED')
  const done = await api(base, T.agent01).post('/cases/4/drafts/specification/finalize', {
    ...args, confirm_overdue: true, overdue_reason: '客户确认定稿晚于内部排期，已书面告知风险。',
  })
  assert.equal(done.status, 201)
  assert.match((await draftDetail(T.agent01, 4, 'specification')).deadline.overdue_reason, /客户确认定稿晚于/)
})

test('无有效版本不可定稿（全部作废的草稿）', async () => {
  const r = await api(base, T.agent01).post('/cases/3/drafts/technical_disclosure/finalize', { create_deadline: false })
  assert.equal(r.status, 409)
  assert.equal(r.body.error.code, 'NO_VALID_VERSION')
})

test('脱敏规则：仅管理员可改；新版本生效；已发出的历史版本快照不回溯', async () => {
  assert.equal((await api(base, T.client01).get('/mask-rules')).status, 403)
  assert.equal((await api(base, T.agent01).post('/mask-rules', { rules: { keywords: ['x'] }, note: '试' })).status, 403)

  const clientBefore = await draftDetail(T.client01, 1)
  const bgV3 = clientBefore.versions.find((v) => v.version_no === 3).paras.find((p) => p.key === 'p1-bg')
  assert.match(bgV3.text, /均温性差/) // v1 规则未遮蔽该词

  const upd = await api(base, T.admin).post('/mask-rules', {
    note: 'v2：增补内部技术语',
    rules: { ...DEFAULT_RULES, keywords: [...DEFAULT_RULES.keywords, '均温性差'] },
  })
  assert.equal(upd.status, 201)
  assert.equal(upd.body.data.version, 2)

  const clientAfter = await draftDetail(T.client01, 1)
  const bgV3Again = clientAfter.versions.find((v) => v.version_no === 3).paras.find((p) => p.key === 'p1-bg')
  assert.match(bgV3Again.text, /均温性差/, '历史版本快照不随规则变化')

  // 代理人基于 v3 保存 v4，新规则才作用于新版本
  const firm = await draftDetail(T.agent01, 1)
  const nv = await save(T.agent01, 1, 'technical_disclosure', {
    paras: firm.current_version.paras.map((p) => (p.key === 'p1-eff' ? { ...p, text: p.text + '补充：量产良率稳定。' } : p)),
    parent_id: firm.current_version.id, summary: 'v4 触发新规则快照',
  })
  assert.equal(nv.status, 201)
  const cliV4 = (await draftDetail(T.client01, 1)).versions.find((v) => v.version_no === 4)
  assert.equal(cliV4.mask_rule_version, 2)
  assert.ok(!cliV4.paras.find((p) => p.key === 'p1-bg').text.includes('均温性差'))
})

test('附件：上传走对象存储（库里无字节），解析状态轮询；换版后旧版本仍打开旧文件', async () => {
  const pdf1 = Buffer.from('%PDF-1.4\nfirst-version-bytes'.padEnd(300, '1'), 'binary')
  const up1 = await fetch(`${base}/api/cases/6/drafts/technical_disclosure/attachments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${T.agent01}`, 'Content-Type': 'application/pdf', 'X-File-Name': encodeURIComponent('六格-交底原稿.pdf') },
    body: pdf1,
  }).then((r) => r.json())
  assert.equal(up1.data.attachments[0].current.parse_status, '解析中')
  assert.equal((await draftDetail(T.agent01, 6)).empty_state, 'attachment_parsing')
  await sleep(1400)
  let d6 = await draftDetail(T.agent01, 6)
  assert.equal(d6.attachments[0].current.parse_status, '就绪')
  assert.match(d6.attachments[0].current.parse_note, /约 \d+ 页/)

  // 保存文本版本 v1：把当时附件文件快照钉在版本上
  const v1 = await save(T.agent01, 6, 'technical_disclosure', { paras: [{ key: 'q1', text: '细胞培养反应器交底初稿。' }], summary: '初稿（挂附件 v1）' })
  assert.equal(v1.status, 201)

  // 换版上传新对象
  const pdf2 = Buffer.from('%PDF-1.4\nsecond-version-bytes'.padEnd(300, '2'), 'binary')
  await fetch(`${base}/api/cases/6/drafts/technical_disclosure/attachments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${T.agent01}`, 'Content-Type': 'application/pdf', 'X-File-Name': encodeURIComponent('六格-交底原稿-v2.pdf') },
    body: pdf2,
  })
  const v2 = await save(T.agent01, 6, 'technical_disclosure', {
    paras: [{ key: 'q1', text: '细胞培养反应器交底初稿（修订）。' }],
    parent_id: (await draftDetail(T.agent01, 6)).versions[0].id, summary: '换版后文本 v2',
  })
  assert.equal(v2.status, 201)

  const detail = await draftDetail(T.agent01, 6)
  const [newV, oldV] = [detail.versions.at(-1).id, detail.versions[0].id]
  const getBuf = async (url) => Buffer.from(await (await fetch(url, { headers: { Authorization: `Bearer ${T.agent01}` } })).arrayBuffer())
  const cur = await getBuf(`${base}/api/attachments/${detail.attachments[0].id}/download`)
  assert.ok(cur.includes(Buffer.from('second-version-bytes')))
  const oldFile = await getBuf(`${base}/api/draft-versions/${oldV}/download`)
  assert.ok(oldFile.includes(Buffer.from('first-version-bytes')))
  const newFile = await getBuf(`${base}/api/draft-versions/${newV}/download`)
  assert.ok(newFile.includes(Buffer.from('second-version-bytes')))
  assert.notEqual(oldFile.toString(), cur.toString())
})

test('附件解析失败有独立状态，不假装就绪', async () => {
  const bad = Buffer.from('%PDF-1.4\nbroken'.padEnd(200, 'x'), 'binary')
  await fetch(`${base}/api/cases/9/drafts/technical_disclosure/attachments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${T.admin}`, 'Content-Type': 'application/pdf', 'X-File-Name': encodeURIComponent('原件损坏.fail.pdf') },
    body: bad,
  })
  await sleep(1400)
  const d = await draftDetail(T.admin, 9)
  assert.equal(d.attachments[0].status, '解析失败')
  assert.match(d.attachments[0].current.parse_note, /无法解析/)
})
