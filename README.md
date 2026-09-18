# 专利云 · 案件全生命周期管理

所内自研的专利案件管理平台。当前里程碑：**整体骨架 + 案件作战台 + 委托与客户 + 官文与期限（官文驱动状态机、双起算口径/三天数口径期限、月周日历、完成度两口径）+ 撰稿与交底（交底书/权利要求草稿/说明书定稿统一版本链、段落级协同冲突取舍、客户脱敏版、附件对象存储、定稿期限联动）**。

## 一键启动

```bash
docker compose up -d --build
```

打开 **http://localhost:8103** 即是真实在办业务（首次启动自动灌入演示数据）。

> 旧版本地卷（`mysql_data`）不含官文/节假日/撰稿（版本链·冲突·附件·脱敏规则）表：升级时执行 `docker compose down -v && docker compose up -d --build` 重建（初始化脚本只在数据卷首次创建时执行；附件对象存储卷 `objectstore_data` 另行保留）。

| 服务 | 端口 | 说明 |
|---|---|---|
| frontend (Nginx) | **8103** | 静态资源 + `/api` 反代到 backend:7103 |
| backend (Express) | **7103** | REST API |
| mysql | 3316 → 3306 | 调试用暴露，生产可删 |
| redis | 6383 → 6379 | 调试用暴露，生产可删 |

## 演示账号（密码均为 `Patent@123`）

| 账号 | 姓名 | 角色 | 能做什么 |
|---|---|---|---|
| `admin` | 周正 | 管理员 | 客户建档、签合同、立项派代理人、全部案件 |
| `agent01` / `agent02` | 李慕华 / 陈远 | 代理人 | 办理名下案件、脱敏案件填理由看全称 |
| `reviewer01` | 郑严 | 审核员 | 授权/驳回/复审登记、查看留痕 |
| `client01/02/03` | 王工/陈博士/赵经理 | 客户管理员 | 仅本客户的案件/合同/费用（越权访问返回 403 错误态） |

预置数据：3 家客户（华芯半导体/蓝湾生物/星野智能）、3 份委托合同、12 件案件（覆盖委托中/已立项/申请/受理/初审/实审中/复审中/授权/驳回/无效十态，含驳回→复审→发回实审的法定回退样例）、34 份官文（含已归档/半截已登记/全部撤回三种形态）、2026 年法定节假日与调休补班表、由官文起算的期限（含临近、逾期留痕、春节/国庆顺延样例）、7 条费用（3 笔逾期红点）。

## 官文与期限

### 官文驱动状态机（允许来回，禁跳步与非法跃迁）
案件十态：委托中 → 已立项 → 申请 → 受理 → 初审 → 实审中 → 授权；实用新型/外观设计初审合格可直接授权；实审/初审驳回 → 复审中，复审可**依法发回实审/初审**（合法回退）、改判授权或维持驳回；授权后可进入无效。登记官文（受理通知书、初审/实审意见、授权办登、驳回决定、复审受理等）即驱动案件流转，仍逐条过状态机：跳步（如受理态登记授权）→ `409 ILLEGAL_TRANSITION`，图中不存在的后退（如实审中→受理）→ `409 ILLEGAL_ROLLBACK`，同态重复登记幂等。官文生命周期：已登记（半截）→ 已归档；可撤回（原因必填留痕），已归档不可撤回。

### 期限口径（界面明示，不让代理人猜）
- **起算日二选一**：`自收到日`（缺实际收到日时按发文日+15 日推定收到日）或 `自发文日`，每条期限与登记表单上都写明当前口径。
- **天数三口径**：`自然日`（不顺延）/ `工作日`（跳过周末与法定节假日，**国务院调休补班日照常计入**）/ `法定节假日顺延`（自然日届满，届满日逢休息日或法定节假日顺延至下一工作日）。节假日表预置国务院年度安排（2026 年含春节 9 天长假及 2/14、2/28 补班）。
- **时区**：日期全按 UTC/日历日字符串存储，「今天/剩几天/是否逾期」一律以服务端 `FIRM_TZ`（默认 `Asia/Shanghai`，可用环境变量覆盖）下的代理所今日为准并随接口下发（`server_today`），界面不按浏览器本地时区自行推算。
- **超期补登二次确认**：登记落点早于代理所今日时，先返回 `409 OVERDUE_CONFIRM` 并带回预览，须勾选确认 + 填写不少于 2 字的超期原因（`400 OVERDUE_REASON_REQUIRED`）才落库，原因随期限留痕展示。
- 登记表单实时调用预览接口展示：起算日及其性质（实际收到日/推定/发文日）、到期日、是否触发顺延、剩余天数。

### 日历与空态
`/calendar` 官文期限日历，月/周两视图、官文可按发文日/收到日切换落点；桌面整月网格、平板（≤1024px）日历+当日事项双栏、手机（≤640px）竖向议程，三种布局各自独立；加载失败（可重试）、区间无落点、案件详情内「该案无官文」与「官文全部撤回」均为分开撰写的独立空态，不统一用「暂无数据」。

### 完成度（两口径，三处一致）
- **关键阶段**：已到达法定阶段数 / 该案件类型关键阶段总数（发明 5 阶段、实用新型/外观 4 阶段；回退不扣已达阶段）。
- **官文归档**：已归档官文数 / 官文登记总数（含已撤回）。走完程序但官文只登记未归档的「半截」案件，两口径方向相反，故界面始终标明当前口径。
- 作战台总览、案件详情、CSV 导出（`GET /api/dashboard/export.csv`）三处数字全部来自后端同一 `lib/completion.js`，作战台与详情可切换口径，CSV 两列都给并在首行写明口径与基准日。

## 撰稿与交底（交底书 / 权利要求草稿 / 说明书定稿）

案件详情页「撰稿」卡片进入 `/cases/:id/writing`。三类文档共用同一套版本链模型与同一组接口。

### 统一版本链（每次保存一个不可变版本）
- 正文按「章节 → 段落（稳定段落 id）」存储；每次保存生成不可变版本（草稿/定稿/作废/冲突合并），可任选两版看前后差异（新增/删除/修改逐段列出），可**回到任一历史版本重开草稿**（新链首版带 `branch_from` 分支标记，旧链原样保留）。
- 保存必须带 `base_version_id`：漏带 → `409 BASE_REQUIRED`，不靠「最后写入」静默覆盖。
- 作废必须填原因并留痕，作废链仍可逐版查看、从任一版重开。

### 代理人与客户同时改同一份交底（段落级冲突，不覆盖也不锁人）
- 后来者保存时服务端做**三路合并**（共同基线 / 先来者链头 / 后来者提交，按段落 id 对齐）：只一方改的段落自动合入；同一段双方都改且不一致（含一方编辑、另一方删除）→ `409 PARAGRAPH_CONFLICT`，逐段带回基线/对方/我的三方文本与修改人，文档**不锁定**、对方修改**不被覆盖**，冲突横幅进入取舍界面。
- 逐段「采用对方 / 保留我的 / 手工合并」后生成 `冲突合并` 版本并回填每条冲突的取舍留痕；取舍期间链头又前进 → 重新带回最新冲突，不静默合并。

### 客户脱敏版（同一条版本链，规则版本化）
- 客户侧只见脱敏版：整章隐藏「在先引用」等未公开章节，标记 `sensitive` 的段落整段隐藏，温度/配比/压力参数与中外专利文献号等按规则句内遮蔽；代理所见原文；两边读写的是**同一条版本链**。
- 脱敏规则版本化（`mask_rules`，管理员可发新版）：每个撰稿版本保存时**快照当时完整规则**，历史版本永远按自带快照渲染——**以后规则调整，已经发出去的历史版本内容不会跟着变**。
- 客户在脱敏视图上保存时，服务端按段落 id 对账：未改动的遮蔽段/隐藏章自动回填原文，占位符不会被固化进正式版本；客户真改的段落才以客户文本为准（仍参与三路冲突判定）。

### 定稿附件原件（对象存储，不入库；换版旧版永久可打开）
- 原件走两阶段上传（init 取不可变 `object_key` + 一次性令牌 → 二进制直传），数据库只存 key/大小/类型等元数据；内置 local 对象存储驱动（compose 挂 `objectstore_data` 卷），`s3` 为预留 seam。
- 附件状态：解析中 / 已完成 / 解析失败；换版 = 新 key + 新版本行，旧 key 永不覆盖删除，任一旧版本原件都能下载。

### 定稿提交期限联动（沿用官文口径）
- 定稿时可选联动生成「定稿提交」期限，**与官文期限完全同一套引擎**：起算口径明示 `自发文日 / 自收到日`（缺实际收到日按发文日+15 日推定），天数口径明示 `自然日 / 工作日 / 法定节假日顺延`，表单实时预览起算日性质、到期日、剩余天数（以代理所今日为准）；落点逾期同样 `OVERDUE_CONFIRM` 二次确认 + 不少于 2 字超期原因留痕。

### 三种空态（分别撰写，不统一占位）
1. **还没有草稿**：引导新建（客户仅交底书可建，权要/定稿由代理人起草并明示）；
2. **草稿全部作废**：列出每条作废链，可看版本/差异，可回到任一版本重开；
3. **附件还在解析**：已建链零正文版本且有解析中原件，可刷新状态或先建空白正文起草。

## 业务规则

### 委托链路（建档 → 签约 → 立项）
1. 管理员「客户建档」→ 2. 签订委托合同（客户状态→已签约）→ 3. 案件立项并指派代理人。
状态机统一拦截非法操作并说明原因：未签约立项 → `409 该客户尚未签署委托合同`；**非法回退**（图中不存在的后退边，如实审中→受理）→ `409 ILLEGAL_ROLLBACK`（提示法定回退只允许经复审程序）；跳级（如已立项→实审中，须经申请/受理/初审）→ `409 ILLEGAL_TRANSITION` 并提示当前可执行的下一步；发明案件初审直接授权 → `409 CTYPE_PATH_MISMATCH`；越权角色 → `403`。驳回→复审中→发回实审/初审是显式合法边，不再拦截。

### 脱敏与留痕
- 案件立项后，所内人员看到的客户名一律为 **缩写·编号**（如 `HX·KH-0001`）；委托中的案件不脱敏；客户管理员看本客户始终明文。
- 查看全称必须二次确认 + 填写理由 → 每次查看写入 `unmask_logs`（查看人/理由/IP/时间），管理员与审核员在「留痕」页可审计。

### 客户隔离
`client_admin` 绑定 `client_id`，所有查询按租户过滤；直接访问他人客户/案件返回 `403 FORBIDDEN`，前端渲染带说明的错误页（非空白页）。

### 离线（代理人出差场景）
- **不拿旧状态糊弄**：断网时顶部横幅明示「离线模式」，所有缓存数据带「更新于 HH:mm，可能已过期」标记；无缓存则明确报错而非空白。
- 变更进入 IndexedDB 待同步队列（页面可见「待同步」条目），恢复网络后自动提交 `/api/sync/batch` 合并。
- **幂等不产生重复案件**：案件创建携带客户端 `client_uuid`（数据库唯一约束兜底）+ 每次变更带 `Idempotency-Key`（Redis + MySQL 双存储，重放返回首次结果）；状态流转按服务器当前状态重新校验——仍合法则合并执行，目标已达成视为重复，非法则标记 `conflict` 并保留服务器状态。

## 本地开发（无 Docker）

```bash
# 后端：内置 sqlite + 内存 Redis，零依赖起服务（与生产同一套可移植 SQL）
cd backend && npm install && npm run dev        # :7103

# 前端
cd frontend && npm install && npm run dev       # :5173，/api 代理到 7103
```

## 测试

```bash
cd backend && npm test
```

81 个用例：状态机单测（十态邻接图、法定回退、跳步/角色/案件类型分叉）、期限引擎单测（自然日/工作日/法定顺延、春节 9 天假与调休补班、普通周末、推定起算）、完成度两口径单测、脱敏单测（含规则快照不变性、客户脱敏保存对账/占位符回填）、段落三路合并单测（同段双改、编辑/删除相向、新增合流），以及真实 HTTP 集成测试（全链路、官文登记驱动流转、超期二次确认留痕、归档/撤回、日历区间、CSV 导出、越权 403、脱敏留痕、幂等重放、离线含 `doc.register/archive/withdraw` 合并去重与冲突、缓存失效；撰稿：三空态、版本链/分支重开/差异、段落级冲突 409 与逐段取舍合并、客户脱敏同链与保存不破坏原文、规则发新版不改历史、附件两阶段上传/令牌一次性/换版旧版可下载、定稿期限联动与逾期留痕）。

## API 概览

```
POST /api/auth/login|logout        GET /api/auth/me
GET  /api/dashboard                作战台聚合（Redis 缓存 20s，写操作即失效）
GET|POST /api/clients              GET /api/clients/:id
POST /api/clients/:id/contracts    签约（重复签约 409）
POST /api/clients/:id/reveal       查看全称（理由必填，留痕）
GET|POST /api/cases                GET /api/cases/:id
POST /api/cases/:id/transition     状态流转（状态机校验）
POST /api/cases/:id/deadlines|fees
GET|POST /api/cases/:id/docs       官文清单 / 登记官文（驱动流转+自动期限，超期需二次确认）
POST /api/cases/:id/deadline-preview  期限到期日实时预览（起算/天数口径明示）
POST /api/docs/:id/archive|withdraw   官文归档（幂等）/ 撤回（原因必填留痕）
GET  /api/calendar?from=&to=&basis=   日历区间（官文发文/收到日落点 + 期限到期落点）
GET  /api/holidays                 GET /api/doc-types   节假日调休表 / 官文类型字典
GET  /api/dashboard/export.csv     完成度 CSV（两口径列）
POST /api/ops/deadlines/:id/complete   POST /api/ops/fees/:id/pay   （幂等）
GET  /api/ops/agents               GET /api/logs/unmask|events

# 撰稿：交底书 disclosure / 权利要求草稿 claims / 说明书定稿 specification
GET  /api/cases/:id/writing                 三类文档状态总览（none/active/void/parsing 四态）
POST /api/cases/:id/writing/:kind           新建草稿链（客户仅 disclosure）
POST /api/cases/:id/writing/:kind/save      保存版本（base_version_id 乐观并发；同段双改 409 PARAGRAPH_CONFLICT；finalize=true 定稿并联动期限）
POST /api/cases/:id/writing/:kind/restart   从历史/作废版本重开新链
POST /api/cases/:id/writing/:kind/final-deadline-preview  定稿提交期限实时预览（与官文同口径）
GET  /api/writing/docs/:docId[?view=masked] 文档详情：版本链/待取舍冲突/附件（代理可 ?view=masked 预览客户视图）
POST /api/writing/docs/:docId/void                 作废（原因必填留痕）
POST /api/writing/docs/:docId/conflicts/resolve    段落冲突逐段取舍 → 冲突合并版本
GET  /api/writing/versions/:versionId              单版本（客户自动脱敏，按版本快照）
GET  /api/writing/docs/:docId/diff?from=&to=       两版段落差异
POST /api/writing/docs/:docId/attachments/init     附件换版/首版：登记解析中版本+不可变 key+一次性令牌
POST /api/writing/attachments/upload/:versionId    二进制直传对象存储（X-Upload-Token）
POST /api/writing/attachments/versions/:versionId/parsed  解析状态回填
GET  /api/writing/attachments/:id/download?version=        下载附件指定版本（缺省最新，旧版永久可开）
GET|POST /api/writing/mask-rules                   脱敏规则版本（管理员发布新版，历史版本不回改）

POST /api/sync/batch               离线变更批量合并（case.* / doc.register / doc.archive / doc.withdraw / deadline.complete / fee.pay）
GET  /api/health
```

所有变更类 `POST` 支持 `Idempotency-Key` 请求头：相同 key 重放返回首次响应（`X-Idempotent-Replay: true`）。

## 目录结构

```
├── docker-compose.yml        # mysql / redis / backend:7103 / frontend:8103（附件对象存储卷 objectstore_data）
├── mysql/init.sql            # 建库建表（种子数据由后端首启写入）
├── backend/
│   ├── src/lib/              # 状态机、官文类型目录、期限引擎、完成度、脱敏（纯函数，可单测）
│   │                         # writing.js 撰稿类型目录、docMask.js 版本化脱敏/对账、paragraphs.js 段落 diff/三路合并
│   ├── src/middleware/       # JWT 鉴权、租户隔离、幂等
│   ├── src/services/         # 业务核心（官文登记/日历/导出/撰稿版本链·冲突·附件对象存储，路由与离线合并共用）
│   ├── src/routes/           # REST 路由（writing.js 撰稿工作台，附件直传在 app.js 挂 express.raw）
│   ├── src/drivers/          # mysql（生产）/ sqlite（开发测试）
│   └── test/                 # node:test 单元 + 集成
└── frontend/
    ├── src/views/            # 作战台 / 委托与客户 / 案件 / 官文日历 / 留痕 / WritingView 撰稿工作台
    ├── src/components/       # 官文登记弹窗、完成度条、漏斗、脱敏弹窗、WritingWorkspace 版本链编辑器等
    ├── src/offline.js        # IndexedDB 缓存 + 待同步队列
    └── public/sw.js          # 应用外壳离线缓存
```
