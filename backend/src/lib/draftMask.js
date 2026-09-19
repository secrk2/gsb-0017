// 撰稿脱敏（纯函数）：客户侧看到的交底/文书隐去未公开技术细节与在先引用。
//
// 关键约束：脱敏结果在版本生成的当时按当时生效的规则版本「固化」为快照，
// 随版本一起存（draft_versions.masked_paras_json）。以后调整规则只对之后的新版本生效，
// 已经发出的历史版本内容绝不回溯变化——本文件只负责「按给定规则生成快照」。
//
// 规则形态（mask_rules.rules_json）：
//   {
//     redact_tags: ['secret','citation'],     // 整段遮蔽的段落标记
//     tag_labels: { secret: '未公开技术细节', citation: '在先引用' },
//     keywords: ['配方比例','催化剂X'],        // 逐词替换
//     patterns: [{ name, regex, flags, replacement }] // 正则替换（如在先专利申请号）
//   }

export const TAG_SECRET = 'secret'
export const TAG_CITATION = 'citation'

export const TAG_LABELS = {
  [TAG_SECRET]: '未公开技术细节',
  [TAG_CITATION]: '在先引用',
}

export const DEFAULT_RULES = {
  redact_tags: [TAG_SECRET, TAG_CITATION],
  tag_labels: TAG_LABELS,
  keywords: [
    '催化剂X',
    '配方比例',
    '刻蚀液配比',
  ],
  patterns: [
    // 中国专利公开/申请号样式（在先引用）：CN 后跟 9~13 位数字与可选种类码
    { name: 'cn-pub-no', regex: 'CN\\s?\\d{9,13}[A-Z]?', flags: 'g', replacement: '【在先专利申请】' },
    // 专利号 ZL...
    { name: 'zl-no', regex: 'ZL\\s?\\d{9,13}[A-Z0-9]?', flags: 'g', replacement: '【在先专利号】' },
  ],
}

export function normRules(rules) {
  const r = rules || {}
  return {
    redact_tags: Array.isArray(r.redact_tags) ? r.redact_tags : [],
    tag_labels: { ...TAG_LABELS, ...(r.tag_labels || {}) },
    keywords: Array.isArray(r.keywords) ? r.keywords.filter((k) => typeof k === 'string' && k.trim()) : [],
    patterns: Array.isArray(r.patterns) ? r.patterns : [],
  }
}

// 校验规则可执行；正则不合法时带名字报错（管理员保存规则时用）
export function validateRules(rules) {
  const r = normRules(rules)
  for (const p of r.patterns) {
    if (!p || !p.regex) return { ok: false, error: '存在缺少 regex 的正则规则' }
    try {
      // eslint-disable-next-line no-new
      new RegExp(p.regex, p.flags || 'g')
    } catch (e) {
      return { ok: false, error: `正则规则「${p.name || p.regex}」不合法：${e.message}` }
    }
  }
  return { ok: true }
}

function compilePatterns(rules) {
  return rules.patterns
    .map((p) => {
      try {
        return { name: p.name, re: new RegExp(p.regex, p.flags || 'g'), replacement: p.replacement || '【已脱敏】' }
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function maskLine(text, rules, compiled) {
  let out = text
  for (const kw of rules.keywords) {
    if (!kw) continue
    out = out.replace(new RegExp(escapeRegExp(kw), 'g'), '【已脱敏】')
  }
  for (const p of compiled) out = out.replace(p.re, p.replacement)
  return out
}

// 行级脱敏（服务端对客户回存段落做「是否未改动」对账时复用同一口径）
export function maskLineText(text, rawRules) {
  const rules = normRules(rawRules)
  return maskLine(text, rules, compilePatterns(rules))
}

/**
 * 生成脱敏段落快照。
 * @returns {{ paras: Array, stats: { total, redacted_blocks, masked_lines } }}
 *   段落结构保留（key/顺序不变），命中整段遮蔽的 text 换成占位说明，tags 去掉敏感标记。
 */
export function maskParas(paras, rawRules) {
  const rules = normRules(rawRules)
  const compiled = compilePatterns(rules)
  const redactSet = new Set(rules.redact_tags)
  const stats = { total: paras.length, redacted_blocks: 0, masked_lines: 0 }
  const out = paras.map((p) => {
    const hitTag = (p.tags || []).find((t) => redactSet.has(t))
    if (hitTag) {
      stats.redacted_blocks++
      return {
        key: p.key,
        text: `【该段含${rules.tag_labels[hitTag] || '敏感内容'}，已按脱敏规则隐去】`,
        tags: [],
        masked: true,
        masked_tag: hitTag,
      }
    }
    const text = maskLine(p.text, rules, compiled)
    if (text !== p.text) stats.masked_lines++
    return { key: p.key, text, tags: [], masked: text !== p.text }
  })
  return { paras: out, stats }
}
