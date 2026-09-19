// 撰稿文书类型目录：三类文书各一条版本链，权限与定稿期限默认口径在此集中声明。

export const DRAFT_TYPES = [
  {
    key: 'technical_disclosure',
    label: '技术交底书',
    clientEditable: true,   // 客户可与代理人同链协作
    clientReadable: true,   // 客户侧看到脱敏版
    deadlineLabel: '交底书定稿提交',
  },
  {
    key: 'claims',
    label: '权利要求草稿',
    clientEditable: false,
    clientReadable: true,
    deadlineLabel: '权利要求定稿提交',
  },
  {
    key: 'specification',
    label: '说明书定稿',
    clientEditable: false,
    clientReadable: true,
    deadlineLabel: '说明书定稿提交',
  },
]

const MAP = new Map(DRAFT_TYPES.map((t) => [t.key, t]))

export function draftTypeDef(key) {
  return MAP.get(key) || null
}

// 定稿提交期限的默认口径（与官文登记同一套：自收到日 + 法定节假日顺延；界面可改并明示）
export const FINALIZE_DEADLINE_DEFAULTS = { anchor: 'receive', dayBasis: 'legal', days: 60 }
