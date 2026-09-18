// 官文生命周期状态常量（各处引用同一组字符串，避免拼写漂移）
export const DOC_STATUS = {
  REGISTERED: '已登记',
  ARCHIVED: '已归档',
  WITHDRAWN: '已撤回',
}

export const DOC_STATUS_LIST = [DOC_STATUS.REGISTERED, DOC_STATUS.ARCHIVED, DOC_STATUS.WITHDRAWN]
