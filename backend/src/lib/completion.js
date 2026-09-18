// 案件完成度——全系统唯一口径来源，作战台 / 案件详情 / CSV 导出三处必须调用同一实现。
//
// 口径一「关键阶段」：按案件类型把法定程序拆成固定关键阶段，
//   分母不随流转回退/驳回变化；案件历史中到达过的关键阶段计入分子
//   （驳回后提起复审不丢前期进度；复审改判授权则补齐授权阶段）。
// 口径二「官文归档」：已归档官文数 / 官文总数。只登记未归档（半截官文）越多，该口径越低。
//
// 注意两口径可能相反：一件走完实审、但官文只登记未及归档的案子，
// 关键阶段口径接近完成、官文归档口径很低——界面必须同时标明当前展示的是哪一种。

import { DOC_STATUS } from './docStatus.js'

export const KEY_STAGES = {
  发明: ['申请', '受理', '初审', '实审中', '授权'],
  实用新型: ['申请', '受理', '初审', '授权'],
  外观设计: ['申请', '受理', '初审', '授权'],
}

export const STAGE_METRIC_LABEL = '关键阶段：已到达法定阶段数 / 该案件类型关键阶段总数'
export const DOC_METRIC_LABEL = '官文归档：已归档官文数 / 官文登记总数'

// reachedStatuses: 案件流转历史（case_events.to_status）的去重集合，或当前状态单元素集合
export function stageCompletion(ctype, reachedStatuses) {
  const stages = KEY_STAGES[ctype] || KEY_STAGES['发明']
  const reached = new Set(reachedStatuses || [])
  const done = stages.filter((s) => reached.has(s)).length
  return { done, total: stages.length, percent: Math.round((done / stages.length) * 100), basis: 'stage' }
}

// docs: [{ status: '已登记'|'已归档'|'已撤回' }]
// 分母含已撤回（撤回官文不再推进案件，登记了却撤回拉低归档完整度，符合「半截」直觉）
export function docCompletion(docs) {
  const total = (docs || []).length
  const archived = (docs || []).filter((d) => d.status === DOC_STATUS.ARCHIVED).length
  return { done: archived, total, percent: total ? Math.round((archived / total) * 100) : 0, basis: 'doc' }
}
