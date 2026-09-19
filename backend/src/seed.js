import bcrypt from 'bcryptjs'
import { query, tx } from './db.js'
import { config } from './config.js'
import { nowIso, daysFromNow, addDays, tzToday } from './lib/dates.js'
import { docTypeDef } from './lib/docTypes.js'
import { computeDueDate } from './lib/deadlineCalc.js'
import { DEFAULT_RULES, normRules, maskParas } from './lib/draftMask.js'
import { getStorage, buildObjectKey, sha256Of } from './services/storage/index.js'

// 首次启动（users 表为空）时写入演示业务数据：
// 3 家委托客户、账号、覆盖全部状态的案件、2026 法定节假日、
// 官文（含已归档/半截/撤回三种形态）与由官文起算的期限、费用。
// 日期全部相对当前时间生成，任何时候 compose up 都是「真实在办」的状态。

const dayOffset = (n) => daysFromNow(n)
const daysAgoIso = (n) => nowIso(new Date(Date.now() - n * 86400000))

// 2026 年国务院办公厅节假日安排（gov.cn 2025-11 公布）
const HOLIDAYS_2026 = [
  { from: '2026-01-01', to: '2026-01-03', name: '元旦' },
  { from: '2026-02-15', to: '2026-02-23', name: '春节' },
  { from: '2026-04-04', to: '2026-04-06', name: '清明节' },
  { from: '2026-05-01', to: '2026-05-05', name: '劳动节' },
  { from: '2026-06-19', to: '2026-06-21', name: '端午节' },
  { from: '2026-09-25', to: '2026-09-27', name: '中秋节' },
  { from: '2026-10-01', to: '2026-10-07', name: '国庆节' },
]
const WORKDAYS_2026 = [
  ['2026-01-04', '元旦调休'],
  ['2026-02-14', '春节调休'],
  ['2026-02-28', '春节调休'],
  ['2026-05-09', '劳动节调休'],
  ['2026-09-20', '国庆节调休'],
  ['2026-10-10', '国庆节调休'],
]

function expandRange(from, to) {
  const out = []
  let cur = from
  while (cur <= to) {
    out.push(cur)
    cur = addDays(cur, 1)
  }
  return out
}

export async function seedIfEmpty() {
  const rows = await query('SELECT COUNT(*) AS n FROM users')
  if (Number(rows[0].n) > 0) return false
  console.log('[seed] 空库，写入初始业务数据…')
  const hash = bcrypt.hashSync('Patent@123', config.bcryptRounds)
  const now = nowIso()

  // 先在库外构建节假日日历，供期限计算使用
  const holidayDates = []
  for (const h of HOLIDAYS_2026) holidayDates.push(...expandRange(h.from, h.to).map((d) => [d, h.name]))
  const cal = {
    holidays: new Set(holidayDates.map(([d]) => d)),
    workdays: new Set(WORKDAYS_2026.map(([d]) => d)),
  }

  // 附件元数据/对象 key 在事务内落库，文件本体事务后写入对象存储
  const pendingAttachments = []
  const draftIds = {}
  await tx(async (d) => {
    // ---- 法定节假日 / 调休补班 ----
    for (const [date, name] of holidayDates) {
      await d.insert('INSERT INTO holidays (date, kind, name) VALUES (?,?,?)', [date, 'holiday', name])
    }
    for (const [date, name] of WORKDAYS_2026) {
      await d.insert('INSERT INTO holidays (date, kind, name) VALUES (?,?,?)', [date, 'workday', name])
    }

    // ---- 账号（密码均为 Patent@123）----
    const users = [
      ['admin', '周正', 'admin', null],
      ['agent01', '李慕华', 'agent', null],
      ['agent02', '陈远', 'agent', null],
      ['reviewer01', '郑严', 'reviewer', null],
      ['client01', '王工', 'client_admin', 1],
      ['client02', '陈博士', 'client_admin', 2],
      ['client03', '赵经理', 'client_admin', 3],
    ]
    for (const [username, name, role, clientId] of users) {
      await d.insert('INSERT INTO users (username, password_hash, name, role, client_id, created_at) VALUES (?,?,?,?,?,?)', [
        username, hash, name, role, clientId, now,
      ])
    }

    // ---- 客户建档 ----
    const clients = [
      ['KH-0001', '华芯半导体科技有限公司', 'HX', '王工', '13800000001', 'wang@huaxin.example'],
      ['KH-0002', '蓝湾生物医药股份公司', 'LW', '陈博士', '13800000002', 'chen@lanwan.example'],
      ['KH-0003', '星野智能装备有限公司', 'XY', '赵经理', '13800000003', 'zhao@xingye.example'],
    ]
    for (const [code, name, short, contact, phone, email] of clients) {
      await d.insert(
        'INSERT INTO clients (code, name, short_code, contact_name, contact_phone, contact_email, status, created_at) VALUES (?,?,?,?,?,?,?,?)',
        [code, name, short, contact, phone, email, '已签约', daysAgoIso(320)]
      )
    }

    // ---- 委托合同 ----
    const contracts = [
      ['HT-2026-001', 1, '专利代理委托合同（华芯）', 120000],
      ['HT-2026-002', 2, '专利代理委托合同（蓝湾）', 96000],
      ['HT-2026-003', 3, '专利代理委托合同（星野）', 88000],
    ]
    for (const [no, cid, title, amount] of contracts) {
      await d.insert(
        'INSERT INTO contracts (contract_no, client_id, title, amount, status, signed_at, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)',
        [no, cid, title, amount, '已签署', daysAgoIso(310), 1, daysAgoIso(310)]
      )
    }

    // ---- 案件（覆盖十态；8 号案演示 驳回→复审→发回实审 的法定回退）----
    // [uuid, client_id, contract_id, title, ctype, status, agent_id, priority, createdDaysAgo]
    const cases = [
      ['seed-case-0001', 1, 1, '一种芯片散热结构及其制备方法', '发明', '实审中', 2, '高', 120],
      ['seed-case-0002', 1, 1, '半导体封装测试方法', '发明', '无效', 2, '普通', 300],
      ['seed-case-0003', 1, 1, '晶圆清洗装置', '实用新型', '受理', 3, '普通', 40],
      ['seed-case-0004', 1, 1, '测试探针卡结构', '发明', '委托中', null, '高', 3],
      ['seed-case-0005', 2, 2, '抗体药物偶联物的制备方法', '发明', '实审中', 3, '高', 100],
      ['seed-case-0006', 2, 2, '细胞培养生物反应器', '实用新型', '初审', 2, '普通', 70],
      ['seed-case-0007', 2, 2, '冻干制剂工艺', '发明', '驳回', 3, '普通', 180],
      ['seed-case-0008', 3, 3, '工业机器人关节模组', '发明', '实审中', 2, '高', 220],
      ['seed-case-0009', 3, 3, '视觉分拣系统', '发明', '申请', 3, '普通', 15],
      ['seed-case-0010', 3, 3, '物流AGV调度方法', '发明', '委托中', null, '普通', 2],
      ['seed-case-0011', 3, 3, '机械臂末端夹具', '外观设计', '授权', 2, '普通', 260],
      ['seed-case-0012', 3, 3, '传送带张紧机构', '实用新型', '复审中', 3, '普通', 160],
    ]
    // 每个案件的法定流转路径（与状态机邻接图一致）
    const PATH = {
      委托中: ['委托中'],
      申请: ['委托中', '已立项', '申请'],
      受理: ['委托中', '已立项', '申请', '受理'],
      初审: ['委托中', '已立项', '申请', '受理', '初审'],
      实审中: ['委托中', '已立项', '申请', '受理', '初审', '实审中'],
      授权发明: ['委托中', '已立项', '申请', '受理', '初审', '实审中', '授权'],
      授权新式: ['委托中', '已立项', '申请', '受理', '初审', '授权'],
      驳回发明: ['委托中', '已立项', '申请', '受理', '初审', '实审中', '驳回'],
      驳回新式: ['委托中', '已立项', '申请', '受理', '初审', '驳回'],
      复审中: ['委托中', '已立项', '申请', '受理', '初审', '驳回', '复审中'],
      发回实审: ['委托中', '已立项', '申请', '受理', '初审', '实审中', '驳回', '复审中', '实审中'],
      无效: ['委托中', '已立项', '申请', '受理', '初审', '实审中', '授权', '无效'],
    }
    const CASE_PATH_KEY = { 2: '无效', 3: '受理', 6: '初审', 7: '驳回发明', 9: '申请', 11: '授权新式', 12: '复审中', 8: '发回实审' }
    const ACTION = {
      委托中: '创建委托', 已立项: '立项', 申请: '提交申请', 受理: '受理登记', 初审: '进入初审',
      实审中: '进入实审', 授权: '授权登记', 驳回: '驳回登记', 复审中: '提起复审', 无效: '无效宣告受理',
    }
    const caseIds = {}
    let caseSeq = 0
    for (const [uuid, cid, contractId, title, ctype, status, agentId, priority, createdAgo] of cases) {
      caseSeq++
      const id = await d.insert(
        `INSERT INTO cases (case_no, client_uuid, client_id, contract_id, title, ctype, status, agent_id, priority, version, created_by, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [`AL-2026-${String(caseSeq).padStart(4, '0')}`, uuid, cid, contractId, title, ctype, status, agentId, priority, 1, 1, daysAgoIso(createdAgo), daysAgoIso(Math.max(0, createdAgo - 30))]
      )
      caseIds[caseSeq] = id
      const pathKey = CASE_PATH_KEY[caseSeq] || (status === '实审中' ? '实审中' : status === '委托中' ? '委托中' : status)
      const path = PATH[pathKey] || [status]
      const span = Math.max(1, Math.floor(createdAgo / (path.length + 1)))
      for (let i = 0; i < path.length; i++) {
        await d.insert(
          'INSERT INTO case_events (case_id, from_status, to_status, action, actor_id, actor_name, reason, created_at) VALUES (?,?,?,?,?,?,?,?)',
          [id, i === 0 ? null : path[i - 1], path[i], ACTION[path[i]] || '状态流转', 1, '周正', '', daysAgoIso(Math.max(0, createdAgo - (path.length - 1 - i) * span))]
        )
      }
    }

    // ---- 官文 + 由官文起算的期限 ----
    // 登记一条官文：按 docTypes 口径用期限引擎算出到期日；可挂接期限完成态/撤回。
    async function addDoc(caseId, typeKey, recvOffset, { docStatus = '已登记', dispatchGap = 3, docNo = '', note = '', deadlineDone = false, noDeadline = false, withdrawReason = '' } = {}) {
      const def = docTypeDef(typeKey)
      const dispatch = recvOffset == null ? null : dayOffset(recvOffset - dispatchGap)
      const receive = recvOffset == null ? null : dayOffset(recvOffset)
      let deadlineId = null
      const nowTs = nowIso()
      const docId = await d.insert(
        `INSERT INTO official_docs (case_id, doc_type, doc_no, dispatch_date, receive_date, status, note, withdraw_reason, created_by, created_at, archived_at, withdrawn_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [caseId, typeKey, docNo, dispatch, receive, docStatus, note, withdrawReason, 1, daysAgoIso(Math.max(0, -recvOffset || 0)),
         docStatus === '已归档' ? nowTs : null, docStatus === '已撤回' ? nowTs : null]
      )
      if (!noDeadline && def?.deadline && receive) {
        const spec = def.deadline
        const r = computeDueDate({ start_date: receive, duration_days: spec.days, day_basis: spec.dayBasis }, cal)
        deadlineId = await d.insert(
          `INSERT INTO deadlines (case_id, doc_id, dtype, anchor_basis, day_basis, start_date, duration_days, due_date, rolled, status, note, completed_at, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [caseId, docId, spec.label, spec.anchor, spec.dayBasis, receive, spec.days, r.due_date, r.rolled ? 1 : 0,
           deadlineDone ? '已完成' : '待处理', note, deadlineDone ? daysAgoIso(Math.max(0, -recvOffset) + 5) : null, nowTs]
        )
        await d.query('UPDATE official_docs SET deadline_id = ? WHERE id = ?', [deadlineId, docId])
      }
      // 官文驱动的状态跃迁已由上方 PATH 事件链统一生成，此处不再重复插事件
      // （正式登记官文走 docService，会同时写事件并回填 doc_id）。
      return { docId, deadlineId }
    }

    // 手工期限（与官文无关；逾期补登必须留原因）
    async function addManualDeadline(caseId, dtype, dueOffset, { anchor = 'receive', basis = 'natural', startOffset = null, days = null, overdueReason = '', note = '' } = {}) {
      await d.insert(
        `INSERT INTO deadlines (case_id, doc_id, dtype, anchor_basis, day_basis, start_date, duration_days, due_date, rolled, status, note, overdue_reason, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [caseId, null, dtype, anchor, basis, startOffset == null ? null : dayOffset(startOffset), days, dayOffset(dueOffset), 0, '待处理', note, overdueReason, daysAgoIso(10)]
      )
    }

    // 1 号案：实审中，前期官文已归档，二审意见半截（待办临近）
    await addDoc(1, '受理通知书', -107, { docStatus: '已归档', deadlineDone: true })
    await addDoc(1, '初步审查意见通知书', -92, { docStatus: '已归档', deadlineDone: true })
    await addDoc(1, '第一次审查意见通知书', -77, { docStatus: '已归档', deadlineDone: true })
    await addDoc(1, '第二次审查意见通知书', -55, { docStatus: '已登记', note: '涉及权利要求1-3创造性' })

    // 2 号案：授权后被提无效（演示 授权→无效）
    await addDoc(2, '受理通知书', -285, { docStatus: '已归档', deadlineDone: true })
    await addDoc(2, '初步审查意见通知书', -250, { docStatus: '已归档', deadlineDone: true })
    await addDoc(2, '第一次审查意见通知书', -220, { docStatus: '已归档', deadlineDone: true })
    await addDoc(2, '授权通知书（办理登记手续通知书）', -180, { docStatus: '已归档', deadlineDone: true })
    await addDoc(2, '无效宣告请求受理通知书', -10, { docStatus: '已登记' })

    // 3 号案：受理阶段，申请费期限在途
    await addDoc(3, '受理通知书', -35, { docStatus: '已登记' })

    // 5 号案：实审中，二审临近 + 一条已逾期的补数据期限（超期补登留痕）
    await addDoc(5, '受理通知书', -95, { docStatus: '已归档', deadlineDone: true })
    await addDoc(5, '初步审查意见通知书', -82, { docStatus: '已归档', deadlineDone: true })
    await addDoc(5, '第一次审查意见通知书', -70, { docStatus: '已归档', deadlineDone: true })
    await addDoc(5, '第二次审查意见通知书', -58, { docStatus: '已登记', note: '需补充对比实验数据' })
    await addManualDeadline(5, '补充实验数据提交', -3, { startOffset: -33, days: 30, note: '审查员要求的补充数据', overdueReason: '客户实验数据产出延误，收文后未及时登记，已加急补交并向客户书面提示风险。' })

    // 6 号案（实用新型）：初审意见答复在途（4 天到期）
    await addDoc(6, '受理通知书', -60, { docStatus: '已归档', deadlineDone: true })
    await addDoc(6, '初步审查意见通知书', -26, { docStatus: '已登记' })

    // 7 号案：驳回后复审请求期限内（15 天）
    await addDoc(7, '受理通知书', -165, { docStatus: '已归档', deadlineDone: true })
    await addDoc(7, '初步审查意见通知书', -140, { docStatus: '已归档', deadlineDone: true })
    await addDoc(7, '第一次审查意见通知书', -120, { docStatus: '已归档', deadlineDone: true })
    await addDoc(7, '驳回决定（实质审查）', -75, { docStatus: '已归档', note: '驳回决定之日起三个月内可请求复审' })

    // 8 号案：实审→驳回→复审→撤销驳回复审发回重审→新审查意见（法定回退样例）
    await addDoc(8, '受理通知书', -200, { docStatus: '已归档', deadlineDone: true })
    await addDoc(8, '初步审查意见通知书', -180, { docStatus: '已归档', deadlineDone: true })
    await addDoc(8, '第一次审查意见通知书', -160, { docStatus: '已归档', deadlineDone: true })
    await addDoc(8, '驳回决定（实质审查）', -90, { docStatus: '已归档', deadlineDone: true })
    await addDoc(8, '复审请求受理通知书', -85, { docStatus: '已归档', noDeadline: true })
    await addDoc(8, '复审请求审查决定（撤销驳回，发回重审）', -40, { docStatus: '已归档', noDeadline: true })
    await addManualDeadline(8, '答复重审审查意见通知书', 12, { startOffset: -18, days: 30, note: '发回重审后合议组指定答复期限' })

    // 9 号案：申请阶段——唯一官文已撤回（「官文全撤回」空态样例），另有手工期限
    await addDoc(9, '缴费通知书', -8, { docStatus: '已撤回', withdrawReason: '经与国知局电话核实，该缴费通知系误发，官方已撤回，登记同步作废。' })
    await addManualDeadline(9, '提交申请文件', 6, { startOffset: -6, days: 12, note: '待客户确认最终文本' })

    // 11 号案（外观设计）：初审合格直接授权，全部官文已归档，办登已完成
    await addDoc(11, '受理通知书', -240, { docStatus: '已归档', deadlineDone: true })
    await addDoc(11, '初步审查合格通知书', -200, { docStatus: '已归档', noDeadline: true })
    await addDoc(11, '授权通知书（办理登记手续通知书）', -170, { docStatus: '已归档', deadlineDone: true })

    // 12 号案（实用新型）：初审驳回→复审中，复审通知书答复 8 天到期
    await addDoc(12, '受理通知书', -150, { docStatus: '已归档', deadlineDone: true })
    await addDoc(12, '驳回决定（初步审查）', -100, { docStatus: '已归档', deadlineDone: true })
    await addDoc(12, '复审请求受理通知书', -95, { docStatus: '已归档', noDeadline: true })
    await addDoc(12, '复审通知书（合议组审查意见）', -22, { docStatus: '已登记' })

    // ---- 费用（含 3 笔逾期红点，与既有看板口径一致）----
    // [caseId, kind, amount, dueInDays, paid]
    const fees = [
      [1, '实质审查费', 2500, -2, false],
      [5, '答复代理费', 3000, -5, false],
      [12, '复审请求费', 1000, -1, false],
      [3, '申请费', 500, 25, false],
      [9, '代理费', 5000, 10, false],
      [8, '申请费', 900, -10, true],
      [11, '登记费', 200, -20, true],
    ]
    for (const [caseId, kind, amount, due, paid] of fees) {
      await d.insert('INSERT INTO fees (case_id, kind, amount, due_date, status, paid_at, created_at) VALUES (?,?,?,?,?,?,?)', [
        caseId, kind, amount, daysFromNow(due), paid ? '已缴' : '待缴', paid ? daysAgoIso(Math.abs(due) + 2) : null, daysAgoIso(30),
      ])
    }

    // ---- 撰稿与交底：版本链 / 脱敏 / 冲突协作 / 定稿 + 附件（三空态样例分布在不同案件）----
    const RULE_VERSION = 1
    await d.insert('INSERT INTO mask_rules (version, rules_json, is_active, note, created_by, created_at) VALUES (?,?,?,?,?,?)',
      [RULE_VERSION, JSON.stringify(normRules(DEFAULT_RULES)), 1, '初始脱敏规则：未公开技术细节、在先引用整段遮蔽；在先知号关键词替换', 1, now])

    // 生成一条版本（paras: [{text, tags?}]，段落 key 显式给出便于跨版本 diff）
    async function addDraftVersion(caseId, dtype, no, paras, { authorId, authorName, authorRole, parent = null, mergedFrom = null, summary = '', attFileId = null, status = '有效', voidReason = '' } = {}) {
      const ps = paras.map((p, i) => ({ key: p.key || `p-${dtype}-${caseId}-${no}-${i}`, text: p.text, tags: p.tags || [] }))
      const masked = maskParas(ps, DEFAULT_RULES)
      const content = ps.map((p) => p.text).join('\n\n')
      const id = await d.insert(
        `INSERT INTO draft_versions (draft_id, version_no, parent_id, merged_from_id, content, paras_json, masked_paras_json, mask_rule_version,
          status, author_id, author_name, author_role, summary, attachment_file_id, merge_resolutions_json, created_at, voided_at, void_reason)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [draftIds[`${caseId}:${dtype}`], no, parent, mergedFrom, content, JSON.stringify(ps), JSON.stringify(masked.paras), RULE_VERSION,
         status, authorId, authorName, authorRole, summary, attFileId, '[]', daysAgoIso(Math.max(1, 30 - no * 4)),
         status === '已作废' ? daysAgoIso(Math.max(1, 30 - no * 4)) : null, voidReason]
      )
      return id
    }
    async function ensureDraft(caseId, dtype) {
      const key = `${caseId}:${dtype}`
      if (!draftIds[key]) {
        draftIds[key] = await d.insert('INSERT INTO drafts (case_id, dtype, status, created_at, updated_at) VALUES (?,?,?,?,?)',
          [caseId, dtype, '编辑中', daysAgoIso(30), daysAgoIso(20)])
      }
      return draftIds[key]
    }
    async function seedAttachment(caseId, dtype, { name, body, parseStatus = '就绪', pages = 12 }) {
      await ensureDraft(caseId, dtype)
      const draftId = draftIds[`${caseId}:${dtype}`]
      const attId = await d.insert('INSERT INTO draft_attachments (draft_id, case_id, label, status, current_file_id, created_by, created_at) VALUES (?,?,?,?,?,?,?)',
        [draftId, caseId, '原件', parseStatus, null, 1, daysAgoIso(20)])
      const sha = sha256Of(body)
      // 先用空 key 落库拿 id，再回填正式 key（与正式上传同一套不可变 key 规则）
      const fileId = await d.insert(
        `INSERT INTO draft_attachment_files (attachment_id, version_no, object_key, bucket, driver, original_name, size, content_type, sha256, parse_status, parse_note, uploaded_by, created_at, parsed_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [attId, 1, '', '', 'local', name, body.length, 'application/pdf', sha, parseStatus,
         parseStatus === '就绪' ? `原件解析完成：约 ${pages} 页，已建立全文索引。` : '', 1, daysAgoIso(20), parseStatus === '就绪' ? daysAgoIso(20) : null])
      const objectKey = buildObjectKey({ caseId, dtype, attachmentId: attId, versionNo: 1, filename: name, sha256: sha })
      await d.query('UPDATE draft_attachment_files SET object_key = ?, bucket = ? WHERE id = ?', [objectKey, 'local', fileId])
      await d.query('UPDATE draft_attachments SET current_file_id = ? WHERE id = ?', [fileId, attId])
      pendingAttachments.push({ objectKey, body })
      return { attId, fileId, objectKey }
    }

    // 1 号案（实审中）：技术交底书，代理人与客户同链协作的活跃样例
    await ensureDraft(1, 'technical_disclosure')
    let v1 = await addDraftVersion(1, 'technical_disclosure', 1, [
      { key: 'p1-bg', text: '本发明涉及高功率芯片的散热结构，旨在解决现有均热板热阻偏高的问题。' },
      { key: 'p1-core', text: '核心结构为石墨烯复合均热层与微通道液冷板叠合，关键刻蚀液配比为商业秘密，具体配方比例暂不在交底中展开。', tags: ['secret'] },
      { key: 'p1-cite', text: '背景技术可参考在先公开 CN115842100A 与 ZL2020101234567 的均热结构。', tags: ['citation'] },
      { key: 'p1-eff', text: '初步实测结温较对照方案下降约 8℃。' },
    ], { authorId: 5, authorName: '王工', authorRole: 'client_admin', summary: '客户提交初版交底' })
    let v2 = await addDraftVersion(1, 'technical_disclosure', 2, [
      { key: 'p1-bg', text: '本发明涉及高功率芯片的散热结构，旨在解决现有均热板热阻偏高、均温性差的问题。' },
      { key: 'p1-core', text: '核心结构为石墨烯复合均热层与微通道液冷板叠合，关键刻蚀液配比为商业秘密，具体配方比例暂不在交底中展开。', tags: ['secret'] },
      { key: 'p1-cite', text: '背景技术可参考在先公开 CN115842100A 与 ZL2020101234567 的均热结构。', tags: ['citation'] },
      { key: 'p1-eff', text: '初步实测结温较对照方案下降约 8℃。' },
    ], { authorId: 2, authorName: '李慕华', authorRole: 'agent', parent: v1, summary: '代理人补充技术问题表述' })
    let v3 = await addDraftVersion(1, 'technical_disclosure', 3, [
      { key: 'p1-bg', text: '本发明涉及高功率芯片的散热结构，旨在解决现有均热板热阻偏高、均温性差的问题。' },
      { key: 'p1-core', text: '核心结构为石墨烯复合均热层与微通道液冷板叠合，界面采用低温烧结纳米银层；关键刻蚀液配比为商业秘密，具体配方比例暂不在交底中展开。', tags: ['secret'] },
      { key: 'p1-cite', text: '背景技术可参考在先公开 CN115842100A 与 ZL2020101234567 的均热结构。', tags: ['citation'] },
      { key: 'p1-eff', text: '初步实测结温较对照方案下降约 8℃，三次重复实验波动在 ±0.5℃ 内。' },
    ], { authorId: 5, authorName: '王工', authorRole: 'client_admin', parent: v1, mergedFrom: v2, summary: '客户补充实验数据（与代理人 v2 自动合并）' })
    await d.query('UPDATE drafts SET current_version_id = ?, updated_at = ? WHERE id = ?', [v3, now, draftIds['1:technical_disclosure']])

    // 1 号案：权利要求草稿编辑中（代理人侧文书，客户只读脱敏版）
    await ensureDraft(1, 'claims')
    let c1 = await addDraftVersion(1, 'claims', 1, [
      { key: 'c1-1', text: '1. 一种芯片散热结构，包括石墨烯复合均热层与微通道液冷板，其特征在于二者之间设有低温烧结纳米银界面层。' },
    ], { authorId: 2, authorName: '李慕华', authorRole: 'agent', summary: '独立权利要求初稿' })
    await d.query('UPDATE drafts SET current_version_id = ? WHERE id = ?', [c1, draftIds['1:claims']])

    // 3 号案（受理）：技术交底书草稿全部作废 → 「草稿全部作废」空态样例
    await ensureDraft(3, 'technical_disclosure')
    let x1 = await addDraftVersion(3, 'technical_disclosure', 1, [
      { key: 'p3-1', text: '本方案为晶圆清洗装置，初版拟采用单片旋转喷淋结构。' },
    ], { authorId: 2, authorName: '李慕华', authorRole: 'agent', summary: '初版', status: '已作废', voidReason: '技术路线与客户最新确认的批式清洗不符，整体作废重来。' })
    await addDraftVersion(3, 'technical_disclosure', 2, [
      { key: 'p3-2', text: '改为批式槽式清洗，配兆波换能器。' },
    ], { authorId: 2, authorName: '李慕华', authorRole: 'agent', parent: x1, summary: '第二版', status: '已作废', voidReason: '客户口头补充信息有误，待重新现场调研后从 v1 重开。' })
    await d.query('UPDATE drafts SET current_version_id = NULL, updated_at = ? WHERE id = ?', [now, draftIds['3:technical_disclosure']])

    // 5 号案：交底书原件刚上传、仍在解析，尚无任何文本版本 → 「附件解析中」空态样例
    await ensureDraft(5, 'technical_disclosure')
    const parsingPdf = Buffer.from(`%PDF-1.4\n% 客户刚上传的交底原件（演示解析中占位）\n`.padEnd(600, 'p'), 'utf8')
    await seedAttachment(5, 'technical_disclosure', { name: '蓝湾-抗体偶联交底书-原稿.pdf', body: parsingPdf, parseStatus: '解析中' })
    // 6 号案：三类文书均无任何草稿（自然落入「还没有草稿」空态，种子不再插数据）

    // 11 号案（已授权）：说明书已定稿 + 对象存储附件原件 + 定稿提交期限（官文同口径）
    await ensureDraft(11, 'specification')
    let s1 = await addDraftVersion(11, 'specification', 1, [
      { key: 's11-1', text: '一种机械臂末端夹具，包括夹座、平行夹爪与浮动补偿组件。' },
      { key: 's11-2', text: '浮动补偿组件包括直线导轨与预压弹簧，容许夹爪在夹持方向产生 2mm 浮动量。' },
    ], { authorId: 2, authorName: '李慕华', authorRole: 'agent', summary: '说明书定稿文本' })
    const specPdf = Buffer.from(`%PDF-1.4\n% 定稿说明书原件（演示占位）\n机械臂末端夹具 说明书定稿\n`.padEnd(1200, 'x'), 'utf8')
    const att = await seedAttachment(11, 'specification', { name: '机械臂末端夹具-说明书定稿.pdf', body: specPdf, parseStatus: '就绪', pages: 18 })
    // 定稿时把版本指向当时的附件文件
    await d.query('UPDATE draft_versions SET attachment_file_id = ? WHERE id = ?', [att.fileId, s1])
    // 定稿提交期限：自授权办登官文收到日起、法定顺延口径（与官文期限同一引擎算出）
    const grant = (await d.query("SELECT dispatch_date, receive_date FROM official_docs WHERE case_id = 11 AND doc_type LIKE '授权通知书%' LIMIT 1"))[0]
    let specDlId = null
    if (grant) {
      const r = computeDueDate({ start_date: grant.receive_date || addDays(grant.dispatch_date, 15), duration_days: 60, day_basis: 'legal' }, cal)
      specDlId = await d.insert(
        `INSERT INTO deadlines (case_id, doc_id, dtype, anchor_basis, day_basis, start_date, duration_days, due_date, rolled, status, note, completed_at, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [11, null, '说明书定稿提交', 'receive', 'legal', grant.receive_date, 60, r.due_date, r.rolled ? 1 : 0, '已完成', '随《说明书定稿》定稿生成', daysAgoIso(150), now])
    }
    await d.query('UPDATE drafts SET status = ?, current_version_id = ?, final_version_id = ?, deadline_id = ?, finalized_at = ?, updated_at = ? WHERE id = ?',
      ['已定稿', s1, s1, specDlId, daysAgoIso(168), now, draftIds['11:specification']])
  })

  // 附件对象本体入库后写对象存储（文件不入库；key 已在上面固化）
  const storage = await getStorage()
  for (const a of pendingAttachments) {
    // eslint-disable-next-line no-await-in-loop
    await storage.put(a.objectKey, a.body, { contentType: 'application/pdf' })
  }

  console.log(`[seed] 完成：3 家客户 / 7 个账号 / 12 件案件（十态全覆盖）/ 2026 节假日 ${holidayDates.length + WORKDAYS_2026.length} 条 / 官文与期限 / 7 条费用 / 撰稿版本链与脱敏规则 v1 / 定稿附件 ${pendingAttachments.length} 份（对象存储）；代理所今日口径 ${tzToday(config.firmTz)}`)
  return true
}
