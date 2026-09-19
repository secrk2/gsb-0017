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
CREATE TABLE IF NOT EXISTS deadlines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL,
  doc_id INTEGER NULL,
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

-- ===== 撰稿与交底：技术交底书 / 权利要求草稿 / 说明书定稿，三类各一条版本链 =====
-- 一个案件每类文书一条 draft；代理人与客户（交底书）共用同一条链。
-- 链上每次保存产生一条不可变 draft_versions；最新有效版本由 current_version_id 指示，
-- 全部版本作废时该指针为 NULL（对应「草稿全部作废」空态，可从任一历史版本重开）。
CREATE TABLE IF NOT EXISTS drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL,
  dtype TEXT NOT NULL,                  -- technical_disclosure 技术交底书 / claims 权利要求草稿 / specification 说明书定稿
  status TEXT NOT NULL DEFAULT '编辑中', -- 编辑中 / 已定稿
  current_version_id INTEGER NULL,      -- 最新「有效」版本；全部作废时为 NULL
  final_version_id INTEGER NULL,        -- 定稿所依据的版本
  deadline_id INTEGER NULL,             -- 定稿提交期限（复用 deadlines 表与官文同一套口径）
  finalized_at TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (case_id, dtype)
);
CREATE INDEX IF NOT EXISTS idx_draft_case ON drafts (case_id);

-- 版本内容一经写入不可修改；「重开/作废」都只追加新版本或改状态位。
-- paras_json 为结构化段落（含 secret/citation 段落标记，所内可见）；
-- masked_paras_json 是生成当时按当时脱敏规则固化的脱敏快照——规则以后调整，已发出的历史版本内容不跟着变。
CREATE TABLE IF NOT EXISTS draft_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id INTEGER NOT NULL,
  version_no INTEGER NOT NULL,
  parent_id INTEGER NULL,               -- 编辑所基于的版本
  merged_from_id INTEGER NULL,          -- 并发合并时服务端的最新版本（无冲突快进时为 NULL）
  content TEXT NOT NULL DEFAULT '',     -- 原文快照（段落以空行分隔）
  paras_json TEXT NOT NULL DEFAULT '[]',
  masked_paras_json TEXT NOT NULL DEFAULT '[]',
  mask_rule_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT '有效',  -- 有效 / 已作废
  author_id INTEGER NULL,
  author_name TEXT NOT NULL DEFAULT '',
  author_role TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',     -- 本次修改说明
  attachment_file_id INTEGER NULL,      -- 该版本生成时附件指向的文件版本（换版后历史版本仍按此打开旧文件）
  merge_resolutions_json TEXT NOT NULL DEFAULT '[]', -- 段落冲突取舍留痕
  created_at TEXT NOT NULL,
  voided_at TEXT NULL,
  void_reason TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_dv_draft ON draft_versions (draft_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dv_draft_ver ON draft_versions (draft_id, version_no);

-- 附件元数据入库，文件本体走对象存储（local 落盘 / S3 兼容），绝不入库。
-- 换版追加 draft_attachment_files 新行（新 object_key），旧行旧 key 永久保留 → 旧版本仍打得开。
CREATE TABLE IF NOT EXISTS draft_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id INTEGER NOT NULL,
  case_id INTEGER NOT NULL,
  label TEXT NOT NULL DEFAULT '原件',
  status TEXT NOT NULL DEFAULT '解析中',  -- 解析中 / 就绪 / 解析失败
  current_file_id INTEGER NULL,
  created_by INTEGER NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_da_draft ON draft_attachments (draft_id);

CREATE TABLE IF NOT EXISTS draft_attachment_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attachment_id INTEGER NOT NULL,
  version_no INTEGER NOT NULL,
  object_key TEXT NOT NULL,             -- 对象存储 key（driver/bucket 一同留档）
  bucket TEXT NOT NULL DEFAULT '',
  driver TEXT NOT NULL DEFAULT 'local',
  original_name TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL DEFAULT 0,
  content_type TEXT NOT NULL DEFAULT '',
  sha256 TEXT NOT NULL DEFAULT '',
  parse_status TEXT NOT NULL DEFAULT '解析中', -- 解析中 / 就绪 / 解析失败
  parse_note TEXT NOT NULL DEFAULT '',
  uploaded_by INTEGER NULL,
  created_at TEXT NULL,
  parsed_at TEXT NULL
);
CREATE INDEX IF NOT EXISTS idx_daf_attachment ON draft_attachment_files (attachment_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_daf_ver ON draft_attachment_files (attachment_id, version_no);

-- 脱敏规则版本：改规则只追加新版本（is_active 指向当前版本）。
-- 历史版本的快照在生成时已固化，规则变更不回溯。
CREATE TABLE IF NOT EXISTS mask_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version INTEGER NOT NULL UNIQUE,
  rules_json TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  created_by INTEGER NULL,
  created_at TEXT NOT NULL
);
