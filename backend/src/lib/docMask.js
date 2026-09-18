// 版本化脱敏。
//
// 关键约束：脱敏规则可以调整，但「已经发出去的历史版本内容」不能跟着变。
// 因此每个撰稿版本（writing_versions.mask_snapshot_json）保存时快照当时完整规则，
// 读取历史版本永远用该版本自己的快照，不去追当前规则。
//
// 规则形态：
//   {
//     version: 1,
//     hideSections: ['prior_refs'],                 // 整章对客户不可见（在先引用等）
//     hideSensitiveParagraphs: true,                // 作者手工标 sensitive 的段落整段隐藏
//     patterns: [                                    // 句内遮蔽：正则 → 占位文案
//       { id, name, regex: '\\d+(?:\\.\\d+)?\\s*℃', replacement: '【温度参数】', flags: 'g' }
//     ]
//   }

export const DEFAULT_RULES = {
  hideSections: ['prior_refs'],
  hideSensitiveParagraphs: true,
  patterns: [
    { id: 'temp', name: '温度工艺参数', regex: '[-+]?\\d+(?:\\.\\d+)?\\s*(?:℃|°C|摄氏度)', replacement: '【温度参数】', flags: 'g' },
    { id: 'ratio', name: '配比/浓度参数', regex: '\\d+(?:\\.\\d+)?\\s*(?:%|wt%|mol%|ppm)', replacement: '【配比参数】', flags: 'g' },
    { id: 'pressure', name: '压力参数', regex: '\\d+(?:\\.\\d+)?\\s*(?:MPa|kPa|Pa|atm|托|Torr)', replacement: '【压力参数】', flags: 'g' },
    { id: 'patent_no', name: '在先专利文献号', regex: '(?:CN|US|EP|WO|JP)\\s?\\d{6,}[A-Z]?\\d?', replacement: '【在先专利文献】', flags: 'gi' },
    { id: 'paper_ref', name: '在先论文引用', regex: '《[^》]{2,60}》\\s*\\(\\d{4}\\)', replacement: '【在先论文引用】', flags: 'g' },
    { id: 'internal_code', name: '内部项目代号', regex: '(?:项目|代号|代码)[:：]?\\s*[A-Z]{1,4}[-－]?\\d{2,}[A-Z0-9-]*', replacement: '【内部项目代号】', flags: 'g' },
  ],
}

export const SENSITIVE_PLACEHOLDER = '█ 该段涉及未公开技术细节，已按撰稿脱敏规则隐藏（代理所见原文）。'
export const SECTION_PLACEHOLDER = '█ 本章按客户脱敏规则不可见（在先引用/未公开章节），代理所见原文。'

export function compilePatterns(rules) {
  return (rules?.patterns || [])
    .map((p) => {
      try {
        return { id: p.id, name: p.name, replacement: p.replacement || '【已脱敏】', re: new RegExp(p.regex, p.flags || 'g') }
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

export function maskParagraphText(text, patterns) {
  let out = text
  const hit = []
  for (const p of patterns) {
    p.re.lastIndex = 0
    if (p.re.test(out)) {
      hit.push(p.name || p.id)
      p.re.lastIndex = 0
      out = out.replace(p.re, p.replacement)
    }
  }
  return { text: out, masked: hit.length > 0, hits: hit }
}

// 对一份版本内容做脱敏（纯函数，服务层与测试共用）。
// 返回结构与原 content 同形，附带 hidden/masked 标记供界面明示。
export function maskContent(content, rules = DEFAULT_RULES) {
  const patterns = compilePatterns(rules)
  const hideSections = new Set(rules?.hideSections || [])
  const hideSensitive = rules?.hideSensitiveParagraphs !== false
  let maskedParagraphs = 0
  const sections = (content?.sections || []).map((s) => {
    if (hideSections.has(s.key)) {
      maskedParagraphs += s.paragraphs.length
      return { key: s.key, title: s.title, hidden: true, placeholder: SECTION_PLACEHOLDER, paragraphs: [] }
    }
    const paragraphs = s.paragraphs.map((p) => {
      if (hideSensitive && p.sensitive) {
        maskedParagraphs++
        return { id: p.id, text: SENSITIVE_PLACEHOLDER, masked: true, reason: 'sensitive' }
      }
      const r = maskParagraphText(p.text, patterns)
      if (r.masked) maskedParagraphs++
      return { id: p.id, text: r.text, masked: r.masked, hits: r.hits }
    })
    return { key: s.key, title: s.title, hidden: false, paragraphs }
  })
  return { sections, masked_paragraphs: maskedParagraphs, mask_rule_version: rules.version ?? null }
}

// 客户在脱敏版上编辑后提交，与链头原文逐段对账，避免脱敏视图造成「看不见的内容被删掉/改坏」：
//   - 整章对客户隐藏（在先引用等）的章节：一律保留链头原文，客户提交忽略；
//   - 整段隐藏（sensitive）：客户提交仍是隐藏占位 → 回填原文；
//   - 句内遮蔽段：客户提交文本与脱敏渲染一致（没动）→ 回填原文；客户实际改了 → 以客户文本为准；
//   - 客户删除某个「可见」段落、或新增段落：照常生效（协同冲突仍按段落三路合并判定）。
// headContent 为链头原文 content；submitted 为 normalizeContent 后的客户提交。
export function reconcileClientContent(headContent, submitted, rules = DEFAULT_RULES) {
  const patterns = compilePatterns(rules)
  const hideSections = new Set(rules?.hideSections || [])
  const hideSensitive = rules?.hideSensitiveParagraphs !== false
  const headSec = new Map((headContent?.sections || []).map((s) => [s.key, s]))
  const subSec = new Map((submitted?.sections || []).map((s) => [s.key, s]))
  // 输出章节以链头为准补齐：客户视图里整章隐藏（在先引用等）不会出现在提交中，必须原样补回
  const allKeys = []
  for (const s of headContent?.sections || []) allKeys.push(s.key)
  for (const s of submitted?.sections || []) if (!headSec.has(s.key)) allKeys.push(s.key)
  const sections = allKeys.map((key) => {
    const s = subSec.get(key)
    const hs = headSec.get(key)
    if (hideSections.has(key) && hs) return { key, title: hs.title, paragraphs: hs.paragraphs.map((p) => ({ ...p })) }
    const subMap = new Map((s?.paragraphs || []).map((p) => [p.id, p]))
    const paragraphs = []
    for (const hp of hs?.paragraphs || []) {
      const sp = subMap.get(hp.id)
      if (!sp) continue // 客户在可见视图里主动删除该段 → 删除生效
      if (hideSensitive && hp.sensitive && sp.text === SENSITIVE_PLACEHOLDER) {
        paragraphs.push({ id: hp.id, text: hp.text, sensitive: true })
        subMap.delete(hp.id)
        continue
      }
      const masked = maskParagraphText(hp.text, patterns)
      if (sp.text === masked.text) paragraphs.push({ id: hp.id, text: hp.text, sensitive: Boolean(hp.sensitive) })
      else paragraphs.push({ id: sp.id, text: sp.text, sensitive: Boolean(hp.sensitive) || Boolean(sp.sensitive) })
      subMap.delete(hp.id)
    }
    // 客户新增段落
    for (const sp of subMap.values()) paragraphs.push({ id: sp.id, text: sp.text, sensitive: Boolean(sp.sensitive) })
    return { key, title: hs?.title || s?.title || key, paragraphs }
  })
  return { sections }
}

// 客户在脱敏视图下手工合并冲突段后，合并文本里保留的占位符按候选原文
// （我的/对方的/基线，均为服务端原文）中真实匹配值顺序回填，避免占位符被固化进正式版本。
export function restorePlaceholders(text, candidates, rules = DEFAULT_RULES) {
  const patterns = compilePatterns(rules)
  let out = text
  for (const p of patterns) {
    const values = []
    for (const c of candidates) {
      p.re.lastIndex = 0
      let m
      while ((m = p.re.exec(c || ''))) values.push(m[0])
    }
    if (!values.length) continue
    const escaped = p.replacement.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    out = out.replace(new RegExp(escaped, 'g'), () => values.shift() ?? p.replacement)
  }
  return out
}
