-- 专利云 · 库表结构（MySQL 8，utf8mb4）
-- 种子数据由后端首次启动时写入（backend/src/seed.js），便于运行时生成密码散列与相对日期。

CREATE DATABASE IF NOT EXISTS patent_cloud CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE patent_cloud;

CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(50) NOT NULL UNIQUE,
  password_hash VARCHAR(100) NOT NULL,
  name VARCHAR(50) NOT NULL,
  role VARCHAR(20) NOT NULL,               -- admin / agent / reviewer / client_admin
  client_id INT NULL,                      -- client_admin 绑定所属客户
  created_at VARCHAR(19) NOT NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS clients (
  id INT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(20) NOT NULL UNIQUE,        -- 客户编号 KH-0001
  name VARCHAR(200) NOT NULL,              -- 客户全称（敏感）
  short_code VARCHAR(10) NOT NULL,         -- 缩写，脱敏展示用
  contact_name VARCHAR(50) NOT NULL DEFAULT '',
  contact_phone VARCHAR(30) NOT NULL DEFAULT '',
  contact_email VARCHAR(100) NOT NULL DEFAULT '',
  status VARCHAR(20) NOT NULL DEFAULT '已建档',   -- 已建档 / 已签约
  created_at VARCHAR(19) NOT NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS contracts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  contract_no VARCHAR(30) NOT NULL UNIQUE,
  client_id INT NOT NULL,
  title VARCHAR(200) NOT NULL,
  amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT '已签署',   -- 已签署 / 已终止
  signed_at VARCHAR(19) NULL,
  created_by INT NULL,
  created_at VARCHAR(19) NOT NULL,
  INDEX idx_contract_client (client_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS cases (
  id INT AUTO_INCREMENT PRIMARY KEY,
  case_no VARCHAR(40) NOT NULL UNIQUE,
  client_uuid VARCHAR(64) NOT NULL UNIQUE,  -- 客户端生成的幂等键：离线重试/重复提交不产生重复案件
  client_id INT NOT NULL,
  contract_id INT NULL,
  title VARCHAR(200) NOT NULL,
  ctype VARCHAR(20) NOT NULL DEFAULT '发明', -- 发明 / 实用新型 / 外观设计
  status VARCHAR(20) NOT NULL DEFAULT '委托中',
  agent_id INT NULL,
  priority VARCHAR(10) NOT NULL DEFAULT '普通',
  version INT NOT NULL DEFAULT 1,           -- 乐观锁版本号
  created_by INT NULL,
  created_at VARCHAR(19) NOT NULL,
  updated_at VARCHAR(19) NOT NULL,
  INDEX idx_case_client (client_id),
  INDEX idx_case_status (status),
  INDEX idx_case_agent (agent_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS case_events (
  id INT AUTO_INCREMENT PRIMARY KEY,
  case_id INT NOT NULL,
  from_status VARCHAR(20) NULL,
  to_status VARCHAR(20) NOT NULL,
  action VARCHAR(60) NOT NULL,
  actor_id INT NULL,
  actor_name VARCHAR(50) NOT NULL DEFAULT '',
  reason VARCHAR(500) NOT NULL DEFAULT '',
  doc_id INT NULL,                          -- 由官文驱动的流转关联官文 id
  created_at VARCHAR(19) NOT NULL,
  INDEX idx_event_case (case_id)
) ENGINE=InnoDB;

-- 官文：国家知识产权局下发的各类通知书/决定书，驱动案件状态机流转。
CREATE TABLE IF NOT EXISTS official_docs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  case_id INT NOT NULL,
  doc_type VARCHAR(60) NOT NULL,            -- 见 backend/src/lib/docTypes.js
  doc_no VARCHAR(60) NOT NULL DEFAULT '',   -- 文书文号
  dispatch_date VARCHAR(10) NULL,           -- 发文日 YYYY-MM-DD
  receive_date VARCHAR(10) NULL,            -- 实际收到日（可后补）
  status VARCHAR(10) NOT NULL DEFAULT '已登记', -- 已登记 / 已归档 / 已撤回
  deadline_id INT NULL,                     -- 登记时自动生成的法定期限
  note VARCHAR(300) NOT NULL DEFAULT '',
  withdraw_reason VARCHAR(300) NOT NULL DEFAULT '',
  created_by INT NULL,
  created_at VARCHAR(19) NOT NULL,
  archived_at VARCHAR(19) NULL,
  withdrawn_at VARCHAR(19) NULL,
  INDEX idx_doc_case (case_id),
  INDEX idx_doc_status (status),
  INDEX idx_doc_dispatch (dispatch_date),
  INDEX idx_doc_receive (receive_date)
) ENGINE=InnoDB;

-- 期限：可由官文自动生成（doc_id 非空）也可手工登记。
-- anchor_basis=receive 自收到日 / dispatch 自发文日；
-- day_basis=natural 自然日 / workday 工作日 / legal 法定节假日顺延。
CREATE TABLE IF NOT EXISTS deadlines (
  id INT AUTO_INCREMENT PRIMARY KEY,
  case_id INT NOT NULL,
  doc_id INT NULL,
  dtype VARCHAR(60) NOT NULL,
  anchor_basis VARCHAR(10) NOT NULL DEFAULT 'receive', -- receive / dispatch
  day_basis VARCHAR(10) NOT NULL DEFAULT 'natural',     -- natural / workday / legal
  start_date VARCHAR(10) NULL,
  duration_days INT NULL,
  due_date VARCHAR(10) NOT NULL,            -- YYYY-MM-DD
  rolled INT NOT NULL DEFAULT 0,            -- legal 口径是否发生节假日顺延
  status VARCHAR(10) NOT NULL DEFAULT '待处理',  -- 待处理 / 已完成（逾期为派生状态）
  note VARCHAR(300) NOT NULL DEFAULT '',
  overdue_reason VARCHAR(300) NOT NULL DEFAULT '',  -- 超期补登原因（落点逾期时二次确认必填，留痕）
  completed_at VARCHAR(19) NULL,
  created_at VARCHAR(19) NOT NULL,
  INDEX idx_dl_case (case_id),
  INDEX idx_dl_doc (doc_id),
  INDEX idx_dl_due (due_date)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS fees (
  id INT AUTO_INCREMENT PRIMARY KEY,
  case_id INT NOT NULL,
  kind VARCHAR(50) NOT NULL,
  amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  due_date VARCHAR(10) NOT NULL,
  status VARCHAR(10) NOT NULL DEFAULT '待缴',    -- 待缴 / 已缴（逾期为派生状态）
  paid_at VARCHAR(19) NULL,
  created_at VARCHAR(19) NOT NULL,
  INDEX idx_fee_case (case_id),
  INDEX idx_fee_due (due_date)
) ENGINE=InnoDB;

-- 法定节假日表：kind=holiday 放假休息日，kind=workday 调休补班（周末上班）。
CREATE TABLE IF NOT EXISTS holidays (
  date VARCHAR(10) PRIMARY KEY,             -- YYYY-MM-DD
  kind VARCHAR(10) NOT NULL,                -- holiday / workday
  name VARCHAR(30) NOT NULL DEFAULT ''
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS unmask_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  user_name VARCHAR(50) NOT NULL,
  client_id INT NOT NULL,
  case_id INT NULL,
  reason VARCHAR(500) NOT NULL,
  ip VARCHAR(64) NOT NULL DEFAULT '',
  created_at VARCHAR(19) NOT NULL,
  INDEX idx_unmask_client (client_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS idempotency_keys (
  ikey VARCHAR(80) PRIMARY KEY,
  user_id INT NULL,
  method VARCHAR(10) NOT NULL DEFAULT '',
  path VARCHAR(200) NOT NULL DEFAULT '',
  status_code INT NOT NULL DEFAULT 200,
  response MEDIUMTEXT NULL,
  created_at VARCHAR(19) NOT NULL
) ENGINE=InnoDB;

-- ===== 撰稿与交底：技术交底书 / 权利要求草稿 / 说明书定稿，三类各一条版本链 =====
-- 每次保存追加一条不可变 draft_versions；代理人与客户（交底书）共用同一条链。
CREATE TABLE IF NOT EXISTS drafts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  case_id INT NOT NULL,
  dtype VARCHAR(30) NOT NULL,           -- technical_disclosure / claims / specification
  status VARCHAR(10) NOT NULL DEFAULT '编辑中', -- 编辑中 / 已定稿
  current_version_id INT NULL,          -- 最新有效版本；全部作废时为 NULL
  final_version_id INT NULL,
  deadline_id INT NULL,                 -- 定稿提交期限（复用官文同一套口径）
  finalized_at VARCHAR(19) NULL,
  created_at VARCHAR(19) NOT NULL,
  updated_at VARCHAR(19) NOT NULL,
  UNIQUE KEY uq_draft_case_type (case_id, dtype),
  INDEX idx_draft_case (case_id)
) ENGINE=InnoDB;

-- masked_paras_json 为按生成当时规则固化的脱敏快照；规则以后调整不回溯历史版本。
CREATE TABLE IF NOT EXISTS draft_versions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  draft_id INT NOT NULL,
  version_no INT NOT NULL,
  parent_id INT NULL,
  merged_from_id INT NULL,
  content MEDIUMTEXT NOT NULL,
  paras_json MEDIUMTEXT NOT NULL,
  masked_paras_json MEDIUMTEXT NOT NULL,
  mask_rule_version INT NOT NULL DEFAULT 1,
  status VARCHAR(10) NOT NULL DEFAULT '有效',  -- 有效 / 已作废
  author_id INT NULL,
  author_name VARCHAR(50) NOT NULL DEFAULT '',
  author_role VARCHAR(20) NOT NULL DEFAULT '',
  summary VARCHAR(300) NOT NULL DEFAULT '',
  attachment_file_id INT NULL,          -- 版本生成时附件指向的文件版本（旧版本永久打开旧对象）
  merge_resolutions_json TEXT NOT NULL,
  created_at VARCHAR(19) NOT NULL,
  voided_at VARCHAR(19) NULL,
  void_reason VARCHAR(300) NOT NULL DEFAULT '',
  UNIQUE KEY uq_dv_draft_ver (draft_id, version_no),
  INDEX idx_dv_draft (draft_id)
) ENGINE=InnoDB;

-- 附件元数据入库，文件本体在对象存储（local 落盘 / S3 兼容），不入库。
CREATE TABLE IF NOT EXISTS draft_attachments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  draft_id INT NOT NULL,
  case_id INT NOT NULL,
  label VARCHAR(60) NOT NULL DEFAULT '原件',
  status VARCHAR(10) NOT NULL DEFAULT '解析中',  -- 解析中 / 就绪 / 解析失败
  current_file_id INT NULL,
  created_by INT NULL,
  created_at VARCHAR(19) NOT NULL,
  INDEX idx_da_draft (draft_id)
) ENGINE=InnoDB;

-- 换版追加新行新 object_key，旧行旧 key 保留 → 旧版本仍打得开。
CREATE TABLE IF NOT EXISTS draft_attachment_files (
  id INT AUTO_INCREMENT PRIMARY KEY,
  attachment_id INT NOT NULL,
  version_no INT NOT NULL,
  object_key VARCHAR(300) NOT NULL,
  bucket VARCHAR(80) NOT NULL DEFAULT '',
  driver VARCHAR(20) NOT NULL DEFAULT 'local',
  original_name VARCHAR(255) NOT NULL DEFAULT '',
  size INT NOT NULL DEFAULT 0,
  content_type VARCHAR(100) NOT NULL DEFAULT '',
  sha256 VARCHAR(64) NOT NULL DEFAULT '',
  parse_status VARCHAR(10) NOT NULL DEFAULT '解析中',
  parse_note VARCHAR(300) NOT NULL DEFAULT '',
  uploaded_by INT NULL,
  created_at VARCHAR(19) NULL,
  parsed_at VARCHAR(19) NULL,
  UNIQUE KEY uq_daf_ver (attachment_id, version_no),
  INDEX idx_daf_attachment (attachment_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS mask_rules (
  id INT AUTO_INCREMENT PRIMARY KEY,
  version INT NOT NULL UNIQUE,
  rules_json MEDIUMTEXT NOT NULL,
  is_active INT NOT NULL DEFAULT 0,
  note VARCHAR(300) NOT NULL DEFAULT '',
  created_by INT NULL,
  created_at VARCHAR(19) NOT NULL
) ENGINE=InnoDB;
