// 撰稿文档类型目录：技术交底书 / 权利要求草稿 / 说明书定稿共用同一条版本链，
// 仅章节结构不同。content 统一形态：
//   { sections: [ { key, title, paragraphs: [ { id, text, sensitive? } ] } ] }
// 段落（paragraph）是版本 diff 与协同冲突检测的最小单位；段落 id 在链内稳定，
// 新增段落由服务端补 id，已存在段落必须带原 id。

export const DOC_KINDS = {
  disclosure: {
    key: 'disclosure',
    label: '技术交底书',
    sections: [
      { key: 'background', title: '背景技术' },
      { key: 'problem', title: '要解决的技术问题' },
      { key: 'solution', title: '技术方案' },
      { key: 'embodiment', title: '具体实施方式' },
      { key: 'effect', title: '有益效果' },
      { key: 'drawings', title: '附图说明' },
      { key: 'prior_refs', title: '在先引用（敏感）', clientHidden: true },
    ],
  },
  claims: {
    key: 'claims',
    label: '权利要求草稿',
    sections: [
      { key: 'independent', title: '独立权利要求' },
      { key: 'dependent', title: '从属权利要求' },
    ],
  },
  specification: {
    key: 'specification',
    label: '说明书定稿',
    sections: [
      { key: 'abstract', title: '摘要' },
      { key: 'claims', title: '权利要求书' },
      { key: 'spec_body', title: '说明书正文' },
      { key: 'prior_refs', title: '在先引用（敏感）', clientHidden: true },
    ],
  },
}

export const DOC_KIND_LIST = Object.values(DOC_KINDS)

export const DOC_STATUS = {
  DRAFT: '草稿中',
  FINAL: '已定稿',
  VOID: '已作废',
}

export const SAVE_TYPES = {
  DRAFT: '草稿',
  FINAL: '定稿',
  VOID: '作废',
  MERGED: '冲突合并',
}

export function docKindDef(kind) {
  return DOC_KINDS[kind] || null
}

// 空文档内容（建稿/无草稿空态共用）
export function emptyContent(kind) {
  const def = docKindDef(kind)
  if (!def) throw new Error(`未知撰稿类型：${kind}`)
  return { sections: def.sections.map((s) => ({ key: s.key, title: s.title, paragraphs: [] })) }
}

// 规整前端提交内容：按类型章节定义过滤/补齐，段落必须 {id?,text}；
// 缺 id 的新段落由 idGen 补稳定 id；去掉纯空白段（前后空白保留在 diff 里会变噪音）。
export function normalizeContent(kind, input, idGen = () => `p_${Math.random().toString(36).slice(2, 10)}`) {
  const def = docKindDef(kind)
  if (!def) throw new Error(`未知撰稿类型：${kind}`)
  const incoming = new Map(
    (Array.isArray(input?.sections) ? input.sections : []).map((s) => [s.key, Array.isArray(s.paragraphs) ? s.paragraphs : []])
  )
  const sections = def.sections.map((s) => {
    const rows = incoming.get(s.key) || []
    const seen = new Set()
    const paragraphs = []
    for (const raw of rows) {
      const text = typeof raw === 'string' ? raw : String(raw?.text ?? '')
      const trimmed = text.trim()
      if (!trimmed) continue // 空段不落版本（diff/合并以非空段为单位）
      const id = (typeof raw === 'object' && raw?.id && String(raw.id)) || idGen()
      if (seen.has(id)) continue
      seen.add(id)
      paragraphs.push({ id, text: trimmed, sensitive: Boolean(typeof raw === 'object' && raw.sensitive) })
    }
    return { key: s.key, title: s.title, paragraphs }
  })
  return { sections }
}

export function contentParagraphCount(content) {
  return (content?.sections || []).reduce((n, s) => n + s.paragraphs.filter((p) => p.text).length, 0)
}

// 两版内容是否逐字相同（相同则不产生空版本）
export function contentEqual(a, b) {
  return JSON.stringify(stripForCompare(a)) === JSON.stringify(stripForCompare(b))
}

function stripForCompare(content) {
  return (content?.sections || []).map((s) => [
    s.key,
    s.paragraphs.map((p) => [p.id, p.text]),
  ])
}
