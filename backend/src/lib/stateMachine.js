// 案件状态机：官文驱动案件在专利法定程序间流转。
// 该模块为纯函数，官文登记、手工流转、离线合并（sync）共用同一套校验。
//
// 原则：
// 1) 只允许沿邻接图的边逐条流转（禁跳步，如 受理→实审中 必须先过初审）；
// 2) 法定回退显式建边（驳回→复审中、复审中→实审中/初审），属于合法跃迁；
//    图中不存在的后退边一律按「非法回退」拦截（如 实审中→受理）；
// 3) 同一状态重复提交视为幂等空操作（离线重放/双击安全）。

export const STATUSES = ['委托中', '已立项', '申请', '受理', '初审', '实审中', '复审中', '授权', '驳回', '无效']

// 在办（未结案）状态，作战台 KPI 复用
export const ACTIVE_STATUSES = ['委托中', '已立项', '申请', '受理', '初审', '实审中', '复审中']

const ROLE_NAMES = { admin: '管理员', agent: '代理人', reviewer: '审核员', client_admin: '客户管理员' }

// from -> to -> { label, roles, requires, onlyCtypes? }
const FLOW = {
  委托中: {
    已立项: { label: '立项', roles: ['admin'], requires: ['contract', 'agent'] },
  },
  已立项: {
    申请: { label: '提交申请', roles: ['admin', 'agent', 'reviewer'] },
  },
  申请: {
    受理: { label: '受理登记', roles: ['admin', 'agent', 'reviewer'] },
  },
  受理: {
    初审: { label: '进入初审', roles: ['admin', 'agent', 'reviewer'] },
  },
  初审: {
    实审中: { label: '进入实审', roles: ['admin', 'agent', 'reviewer'], onlyCtypes: ['发明'] },
    授权: { label: '初审合格授权', roles: ['admin', 'reviewer'], onlyCtypes: ['实用新型', '外观设计'] },
    驳回: { label: '初审驳回登记', roles: ['admin', 'reviewer'] },
  },
  实审中: {
    授权: { label: '授权登记', roles: ['admin', 'reviewer'] },
    驳回: { label: '驳回登记', roles: ['admin', 'reviewer'] },
  },
  驳回: {
    复审中: { label: '提起复审', roles: ['admin', 'agent', 'reviewer'] },
  },
  复审中: {
    实审中: { label: '撤销驳回复审发回重审', roles: ['admin', 'reviewer'] },
    初审: { label: '撤销驳回复审发回初审', roles: ['admin', 'reviewer'] },
    授权: { label: '复审改判授权', roles: ['admin', 'reviewer'] },
    驳回: { label: '维持驳回', roles: ['admin', 'reviewer'] },
  },
  授权: {
    无效: { label: '无效宣告受理', roles: ['admin', 'reviewer'] },
  },
}

// 阶段序号：用于在「图中没有边」时区分非法回退（后退）与跳步（跨越）。
// 复审在实审之后（复审结论可依法把案件发回实审/初审，那些是 FLOW 中显式合法边）。
const RANK = { 委托中: 0, 已立项: 1, 申请: 2, 受理: 3, 初审: 4, 实审中: 5, 复审中: 6, 授权: 7, 驳回: 7, 无效: 8 }

export function allowedTargets(from) {
  return Object.keys(FLOW[from] || {})
}

// 返回当前用户在某案件上可执行的流转动作（前端按此渲染按钮）
export function allowedTransitionsFor(status, role, isAssignee, ctype = null) {
  return Object.entries(FLOW[status] || {})
    .filter(([, spec]) => spec.roles.includes(role) && (role !== 'agent' || isAssignee))
    .filter(([, spec]) => !spec.onlyCtypes || (ctype && spec.onlyCtypes.includes(ctype)))
    .map(([to, spec]) => ({ to, label: spec.label }))
}

/**
 * 校验一次状态流转。
 * @param {string} ctype 案件类型（发明/实用新型/外观设计），用于初审后的路径分叉
 * @returns {ok:true, noop?:bool, label?:string} | {ok:false, http, code, message}
 */
export function checkTransition({ from, to, role, isAssignee, hasContract, hasAgent, ctype }) {
  if (!STATUSES.includes(to)) {
    return { ok: false, http: 400, code: 'BAD_STATUS', message: `未知状态「${to}」` }
  }
  // 幂等：目标状态即当前状态 → 视为成功空操作（离线重试/双击安全）
  if (from === to) {
    return { ok: true, noop: true }
  }
  const spec = (FLOW[from] || {})[to]
  if (!spec) {
    const isRollback = RANK[to] < RANK[from]
    if (isRollback) {
      return {
        ok: false,
        http: 409,
        code: 'ILLEGAL_ROLLBACK',
        message: `非法回退：案件当前处于「${from}」，不能直接退回「${to}」。法定回退只允许经复审程序（驳回→复审中→发回实审/初审），且须凭复审决定书登记；如需更正历史登记，请由管理员走异常处理。`,
      }
    }
    const next = allowedTargets(from)
    return {
      ok: false,
      http: 409,
      code: 'ILLEGAL_TRANSITION',
      message: `非法流转：不能从「${from}」直接变更为「${to}」（禁止跳步）。${next.length ? `当前可执行的下一步：${next.map((t) => `「${t}」`).join('、')}。` : '该案件已处于终态，不可再流转。'}`,
    }
  }
  if (spec.onlyCtypes && (!ctype || !spec.onlyCtypes.includes(ctype))) {
    return {
      ok: false,
      http: 409,
      code: 'CTYPE_PATH_MISMATCH',
      message: `「${spec.label}」仅适用于${spec.onlyCtypes.join('、')}案件；当前案件类型为「${ctype || '未指定'}」。发明申请须经实质审查，实用新型/外观设计初审合格后可直接授权。`,
    }
  }
  if (!spec.roles.includes(role)) {
    const need = spec.roles.map((r) => ROLE_NAMES[r]).join('或')
    return { ok: false, http: 403, code: 'ROLE_DENIED', message: `当前角色（${ROLE_NAMES[role] || role}）无权执行「${spec.label}」，该操作需${need}处理。` }
  }
  if (role === 'agent' && !isAssignee) {
    return { ok: false, http: 403, code: 'NOT_ASSIGNEE', message: '代理人只能操作自己名下的案件。' }
  }
  if (spec.requires?.includes('contract') && !hasContract) {
    return { ok: false, http: 409, code: 'NO_CONTRACT', message: '该客户尚未签署委托合同，不能立项。请先在「委托与客户」中完成合同签订。' }
  }
  if (spec.requires?.includes('agent') && !hasAgent) {
    return { ok: false, http: 409, code: 'NO_AGENT', message: '立项时必须指定承办代理人。' }
  }
  return { ok: true, label: spec.label }
}
