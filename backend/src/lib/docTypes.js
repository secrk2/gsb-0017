// 官文类型目录：定义每类官文对案件状态机的效力，以及其法定期限的默认口径。
// 登记官文时：to 非 null 的，驱动案件状态流转（仍由 stateMachine 逐条校验，禁跳步）；
// to 为 null 的中性官文（缴费通知、口审通知等）只登记不流转。

// 期限默认值说明：
//   anchor: 起算日口径 receive=自收到日（《细则》默认自推定收到日起算，此处以实际收到日为准并界面明示）
//                              dispatch=自发文日
//   dayBasis: natural=自然日 / workday=工作日（跳过周末与法定节假日，调休上班计入）/
//                        legal=法定期限口径：按自然日届满，届满日为休息日或法定节假日的顺延至第一个工作日
//   days: 期限天数；optional: 该类官文默认不强制挂期限（登记时可删）
export const DOC_TYPES = [
  // ---- 受理 ----
  { group: '受理', key: '受理通知书', to: '受理', deadline: { label: '缴纳申请费', anchor: 'receive', dayBasis: 'legal', days: 60 } },
  { group: '受理', key: '专利申请受理通知书（不予受理）', to: null, deadline: null },

  // ---- 初审 ----
  { group: '初审', key: '初步审查意见通知书', to: '初审', deadline: { label: '答复初步审查意见', anchor: 'receive', dayBasis: 'legal', days: 30 } },
  { group: '初审', key: '发明专利申请公布通知书', to: '初审', deadline: null },
  { group: '初审', key: '初步审查合格通知书', to: null, deadline: null },
  { group: '初审', key: '驳回决定（初步审查）', to: '驳回', deadline: { label: '提起复审请求', anchor: 'receive', dayBasis: 'legal', days: 90 } },

  // ---- 实审 ----
  { group: '实审', key: '第一次审查意见通知书', to: '实审中', deadline: { label: '答复第一次审查意见', anchor: 'receive', dayBasis: 'legal', days: 120 } },
  { group: '实审', key: '第二次审查意见通知书', to: '实审中', deadline: { label: '答复第二次审查意见', anchor: 'receive', dayBasis: 'legal', days: 60 } },
  { group: '实审', key: '第N次审查意见通知书', to: '实审中', deadline: { label: '答复审查意见', anchor: 'receive', dayBasis: 'legal', days: 60 } },
  { group: '实审', key: '审查意见通知书（其他）', to: '实审中', deadline: { label: '答复审查意见', anchor: 'receive', dayBasis: 'legal', days: 60 } },
  { group: '实审', key: '驳回决定（实质审查）', to: '驳回', deadline: { label: '提起复审请求', anchor: 'receive', dayBasis: 'legal', days: 90 } },

  // ---- 授权办登 ----
  { group: '授权办登', key: '授权通知书（办理登记手续通知书）', to: '授权', deadline: { label: '办理登记手续并缴纳年费', anchor: 'receive', dayBasis: 'legal', days: 60 } },
  { group: '授权办登', key: '授予专利权通知书', to: '授权', deadline: { label: '办理登记手续', anchor: 'receive', dayBasis: 'legal', days: 60 } },

  // ---- 复审 ----
  { group: '复审', key: '复审请求受理通知书', to: '复审中', deadline: null },
  { group: '复审', key: '复审通知书（合议组审查意见）', to: null, deadline: { label: '答复复审通知书', anchor: 'receive', dayBasis: 'legal', days: 30 } },
  { group: '复审', key: '口头审理通知书', to: null, deadline: { label: '口头审理意见陈述', anchor: 'dispatch', dayBasis: 'workday', days: 7, optional: true } },
  { group: '复审', key: '复审请求审查决定（撤销驳回，发回重审）', to: '实审中', deadline: null },
  { group: '复审', key: '复审请求审查决定（撤销初审驳回，发回初审）', to: '初审', deadline: null },
  { group: '复审', key: '复审请求审查决定（维持驳回）', to: '驳回', deadline: null },

  // ---- 无效 ----
  { group: '无效', key: '无效宣告请求受理通知书', to: '无效', deadline: { label: '无效宣告意见陈述', anchor: 'receive', dayBasis: 'legal', days: 30 } },
  { group: '无效', key: '无效宣告请求审查决定', to: null, deadline: null },

  // ---- 中性通知（不驱动状态机）----
  { group: '缴费与其他通知', key: '缴费通知书', to: null, deadline: { label: '按通知书缴费', anchor: 'receive', dayBasis: 'legal', days: 30, optional: true } },
  { group: '缴费与其他通知', key: '视为撤回通知书', to: null, deadline: { label: '请求恢复权利', anchor: 'receive', dayBasis: 'legal', days: 60 } },
  { group: '缴费与其他通知', key: '其他通知书', to: null, deadline: { label: '按通知书办理', anchor: 'receive', dayBasis: 'natural', days: 30, optional: true } },
]

const DOC_MAP = new Map(DOC_TYPES.map((d) => [d.key, d]))

export function docTypeDef(key) {
  return DOC_MAP.get(key) || null
}

export const DOC_GROUPS = DOC_TYPES.reduce((acc, d) => {
  ;(acc[d.group] ||= []).push(d.key)
  return acc
}, {})

export const ANCHOR_LABELS = { receive: '自收到日', dispatch: '自发文日' }
export const DAY_BASIS_LABELS = {
  natural: '自然日',
  workday: '工作日（不含周末及法定节假日，调休上班日计入）',
  legal: '法定节假日顺延（自然日届满，逢休息日/法定节假日顺延至下一工作日）',
}
