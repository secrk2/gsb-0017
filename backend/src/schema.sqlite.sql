-- 开发/测试专用（node:sqlite）。与 mysql/init.sql 保持同构，仅类型写法不同。
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  client_id INTEGER NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  short_code TEXT NOT NULL,
  contact_name TEXT NOT NULL DEFAULT '',
  contact_phone TEXT NOT NULL DEFAULT '',
  contact_email TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '已建档',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contracts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_no TEXT NOT NULL UNIQUE,
  client_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT '已签署',
  signed_at TEXT NULL,
  created_by INTEGER NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contract_client ON contracts (client_id);

CREATE TABLE IF NOT EXISTS cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_no TEXT NOT NULL UNIQUE,
  client_uuid TEXT NOT NULL UNIQUE,
  client_id INTEGER NOT NULL,
  contract_id INTEGER NULL,
  title TEXT NOT NULL,
  ctype TEXT NOT NULL DEFAULT '发明',
  status TEXT NOT NULL DEFAULT '委托中',
  agent_id INTEGER NULL,
  priority TEXT NOT NULL DEFAULT '普通',
  version INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_case_client ON cases (client_id);
CREATE INDEX IF NOT EXISTS idx_case_status ON cases (status);
CREATE INDEX IF NOT EXISTS idx_case_agent ON cases (agent_id);

CREATE TABLE IF NOT EXISTS case_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL,
  from_status TEXT NULL,
  to_status TEXT NOT NULL,
  action TEXT NOT NULL,
  actor_id INTEGER NULL,
  actor_name TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  doc_id INTEGER NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_event_case ON case_events (case_id);

-- 官文：国家知识产权局下发的各类通知书/决定书，驱动案件状态机流转。
-- 发文日与收到日分别登记；推定收到日=发文日+15 日（仅在未补录实际收到日时用于起算）。
CREATE TABLE IF NOT EXISTS official_docs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL,
  doc_type TEXT NOT NULL,               -- 见 lib/docTypes.js
  doc_no TEXT NOT NULL DEFAULT '',      -- 文书文号
  dispatch_date TEXT NULL,              -- 发文日 YYYY-MM-DD
  receive_date TEXT NULL,               -- 实际收到日（可后补；补录后需重算所挂期限）
  status TEXT NOT NULL DEFAULT '已登记', -- 已登记 / 已归档 / 已撤回
  deadline_id INTEGER NULL,             -- 登记时自动生成的法定期限
  note TEXT NOT NULL DEFAULT '',
  withdraw_reason TEXT NOT NULL DEFAULT '',
  created_by INTEGER NULL,
  created_at TEXT NOT NULL,
  archived_at TEXT NULL,
  withdrawn_at TEXT NULL
);
CREATE INDEX IF NOT EXISTS idx_doc_case ON official_docs (case_id);
CREATE INDEX IF NOT EXISTS idx_doc_status ON official_docs (status);
CREATE INDEX IF NOT EXISTS idx_doc_dispatch ON official_docs (dispatch_date);
CREATE INDEX IF NOT EXISTS idx_doc_receive ON official_docs (receive_date);

-- 期限：可以由官文自动生成（doc_id 非空），也可手工登记。
-- anchor_basis=receive 自收到日 / dispatch 自发文日（界面明示，不让代理人猜）；
-- day_basis=natural 自然日 / workday 工作日 / legal 法定节假日顺延。
-- start_date 为实际起算日快照，duration_days 为期限天数，due_date 为算出的到期日。
-- 期限：可以由官文自动生成（doc_id 非空），手工登记，或由撰稿定稿联动生成（writing_doc_id 非空）。
CREATE TABLE IF NOT EXISTS deadlines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL,
  doc_id INTEGER NULL,
  writing_doc_id INTEGER NULL,          -- 撰稿定稿联动生成的定稿提交期限
  dtype TEXT NOT NULL,
  anchor_basis TEXT NOT NULL DEFAULT 'receive',
  day_basis TEXT NOT NULL DEFAULT 'natural',
  start_date TEXT NULL,
  duration_days INTEGER NULL,
  due_date TEXT NOT NULL,
  rolled INTEGER NOT NULL DEFAULT 0,     -- legal 口径是否发生节假日顺延
  status TEXT NOT NULL DEFAULT '待处理',
  note TEXT NOT NULL DEFAULT '',
  overdue_reason TEXT NOT NULL DEFAULT '', -- 超期补登原因（落点已逾期时二次确认必填，留痕）
  completed_at TEXT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dl_case ON deadlines (case_id);
CREATE INDEX IF NOT EXISTS idx_dl_doc ON deadlines (doc_id);
CREATE INDEX IF NOT EXISTS idx_dl_due ON deadlines (due_date);

CREATE TABLE IF NOT EXISTS fees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT '待缴',
  paid_at TEXT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fee_case ON fees (case_id);
CREATE INDEX IF NOT EXISTS idx_fee_due ON fees (due_date);

-- 法定节假日表：kind=holiday 放假休息日，kind=workday 调休补班（周末上班）。
-- 由 seed 预置国务院公布的年度安排；缺失日期按普通周末规则处理。
CREATE TABLE IF NOT EXISTS holidays (
  date TEXT PRIMARY KEY,                -- YYYY-MM-DD
  kind TEXT NOT NULL,                   -- holiday / workday
  name TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS unmask_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  user_name TEXT NOT NULL,
  client_id INTEGER NOT NULL,
  case_id INTEGER NULL,
  reason TEXT NOT NULL,
  ip TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_unmask_client ON unmask_logs (client_id);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  ikey TEXT PRIMARY KEY,
  user_id INTEGER NULL,
  method TEXT NOT NULL DEFAULT '',
  path TEXT NOT NULL DEFAULT '',
  status_code INTEGER NOT NULL DEFAULT 200,
  response TEXT NULL,
  created_at TEXT NOT NULL
);

-- ============ 撰稿（交底书 / 权利要求草稿 / 说明书定稿）============
-- 三类文档共用同一套版本链模型：一份 writing_docs 行 = 一条版本链；
-- 每次保存生成一个不可变 writing_versions 行，可查看任意两版差异、可回到任一版本重开草稿。

CREATE TABLE IF NOT EXISTS writing_docs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL,
  doc_kind TEXT NOT NULL,               -- disclosure 技术交底书 / claims 权利要求草稿 / specification 说明书定稿
  title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '草稿中', -- 草稿中 / 已定稿 / 已作废
  current_version INTEGER NOT NULL DEFAULT 0, -- 链头版本号（0 尚无任何已保存版本）
  head_version_id INTEGER NULL,
  final_version_id INTEGER NULL,        -- status=已定稿 时指向定稿版本（也可能是 head，或定稿后再起草稿）
  finalized_at TEXT NULL,
  finalized_by INTEGER NULL,
  created_by INTEGER NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wdoc_case ON writing_docs (case_id);
CREATE INDEX IF NOT EXISTS idx_wdoc_kind ON writing_docs (doc_kind);

-- 不可变版本：每次保存（草稿/定稿/作废/冲突取舍）一行。
-- content 为「按章节分块的段落数组」JSON，段落是冲突检测与 diff 的最小单位。
-- mask_snapshot 为保存当时的脱敏规则快照 JSON：历史版本脱敏内容不随规则调整而变化。
-- base_version_id 指回编辑所基于的版本（null=首版）；parent_version_id 为链上父版本；
-- 从旧版本重开草稿时，新保存版本的 parent 仍为链头，base 为被重开的旧版本（形成分支）。
CREATE TABLE IF NOT EXISTS writing_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id INTEGER NOT NULL,
  version_no INTEGER NOT NULL,          -- 链内递增
  save_type TEXT NOT NULL DEFAULT '草稿', -- 草稿 / 定稿 / 作废 / 冲突合并
  base_version_id INTEGER NULL,
  parent_version_id INTEGER NULL,
  branch_from_version_id INTEGER NULL,  -- 非空表示该版本从历史版本重开（分支）
  content_json TEXT NOT NULL,           -- {sections:[{key,title,paragraphs:[{id,text,sensitive}]}]}
  summary TEXT NOT NULL DEFAULT '',     -- 保存说明（留痕，必填或默认生成）
  mask_snapshot_json TEXT NOT NULL,     -- 保存时生效的脱敏规则快照
  actor_id INTEGER NULL,
  actor_name TEXT NOT NULL DEFAULT '',
  actor_role TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wver_doc ON writing_versions (doc_id, version_no);

-- 段落级冲突留痕：代理人与客户基于同一版本分别改了同一段落，
-- 后来者保存时不允许静默覆盖，也不以「已锁定」拒绝——登记冲突并进入取舍界面。
-- resolution 为 null 表示待取舍；取舍后生成「冲突合并」版本并回填 resolution/resolved_version_id。
CREATE TABLE IF NOT EXISTS writing_conflicts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id INTEGER NOT NULL,
  section_key TEXT NOT NULL,
  paragraph_id TEXT NOT NULL,
  base_version_id INTEGER NOT NULL,     -- 共同基线版本
  incoming_version_id INTEGER NOT NULL, -- 先来保存（已在链上）
  pending_version_id INTEGER NULL,      -- 后来者的保存尝试（409 时未落链；冲突取舍提交后作为合并版本参考）
  base_text TEXT NOT NULL DEFAULT '',
  incoming_text TEXT NOT NULL DEFAULT '',
  pending_text TEXT NOT NULL DEFAULT '',
  incoming_actor_name TEXT NOT NULL DEFAULT '',
  pending_actor_name TEXT NOT NULL DEFAULT '',
  pending_content_json TEXT NULL,         -- 后来者本次完整提交（已做脱敏对账）；刷新页面后取舍仍可恢复
  status TEXT NOT NULL DEFAULT '待取舍', -- 待取舍 / 已取舍
  resolution TEXT NOT NULL DEFAULT '',  -- incoming / pending / merged
  resolved_text TEXT NOT NULL DEFAULT '',
  resolved_by INTEGER NULL,
  resolved_version_id INTEGER NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT NULL
);
CREATE INDEX IF NOT EXISTS idx_wconf_doc ON writing_conflicts (doc_id, status);

-- 附件原件走对象存储（只存 object_key，不入库内容）。
-- 原件换版：同一逻辑附件每次上传产生不可变 writing_attachment_versions 行与不可变 object_key；
-- 旧版本永远打得开（旧 key 不被覆盖删除）。
CREATE TABLE IF NOT EXISTS writing_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id INTEGER NOT NULL,
  filename TEXT NOT NULL,
  current_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_watt_doc ON writing_attachments (doc_id);

CREATE TABLE IF NOT EXISTS writing_attachment_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attachment_id INTEGER NOT NULL,
  version_no INTEGER NOT NULL,
  object_key TEXT NOT NULL UNIQUE,      -- 对象存储不可变 key
  size_bytes INTEGER NOT NULL DEFAULT 0,
  content_type TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '解析中', -- 解析中 / 已完成 / 解析失败
  parse_note TEXT NOT NULL DEFAULT '',
  uploaded_by INTEGER NULL,
  uploaded_by_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  parsed_at TEXT NULL
);
CREATE INDEX IF NOT EXISTS idx_wattv_att ON writing_attachment_versions (attachment_id, version_no);

-- 脱敏规则版本化：规则调整只发新版本；保存撰稿版本时把当时规则快照进 mask_snapshot_json，
-- 已经发出去的历史版本按旧快照呈现，不随规则变化。
CREATE TABLE IF NOT EXISTS mask_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version INTEGER NOT NULL UNIQUE,
  rules_json TEXT NOT NULL,             -- {patterns:[{id,level,name,regex,replacement}], hideSections:[sectionKey]}
  is_active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER NULL,
  created_at TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT ''
);
