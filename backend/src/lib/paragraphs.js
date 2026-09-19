// 撰稿段落模型与三路合并（纯函数，服务层与测试共用）。
//
// 段落是版本内容的最小单位：{ key, text, tags: [] }，key 一经分配在整条版本链上稳定。
// 代理人与客户常常同时改同一份交底：后保存者携带其所基于的 parent_id，
// 服务端拿 parent（base）/ 提交方（mine）/ 服务端最新（theirs）做三路合并——
//   - 只有一方改：自动采用，不打断人；
//   - 同一段双方都改且改成不同内容：段落级冲突，交回取舍，绝不静默覆盖；
//   - 一方删、另一方改：同样算冲突（删除也不能把别人的改动悄悄带走）；
//   - 双方都删：删除。
// 段落新增用客户端生成的 uuid 作 key，双方各加各的，不构成冲突。

export function normText(s) {
  return String(s ?? '').replace(/\r\n/g, '\n').trim()
}

export function normTags(tags) {
  return Array.from(new Set((Array.isArray(tags) ? tags : []).map((t) => String(t)).filter(Boolean))).sort()
}

// 规整外部提交的段落：去空白段、统一结构。keyless 段落由调用方（服务层）补 key。
export function normalizeParas(input) {
  const list = Array.isArray(input) ? input : []
  const out = []
  for (const p of list) {
    if (typeof p === 'string') {
      const text = normText(p)
      if (text) out.push({ key: '', text, tags: [] })
      continue
    }
    const text = normText(p?.text)
    if (!text) continue
    out.push({ key: String(p.key || ''), text, tags: normTags(p?.tags) })
  }
  return out
}

// 段落原文快照：以空行分隔落 content 列（人读 / 导出用；paras_json 才是结构化真源）
export function parasToContent(paras) {
  return paras.map((p) => p.text).join('\n\n')
}

const sameEdits = (a, b) => normText(a.text) === normText(b.text) && normTags(a.tags).join('|') === normTags(b.tags).join('|')

function indexByKey(paras) {
  const m = new Map()
  for (const p of paras) m.set(p.key, p)
  return m
}

/**
 * 三路合并。
 * @param {Array|null} baseParas 提交方所基于的父版本（首次保存传 null/[]）
 * @param {Array} mineParas 提交方段落
 * @param {Array} theirsParas 服务端最新段落（无并发时与 base 相同）
 * @returns {{ paras: Array, conflicts: Array<{key, base, mine, theirs, reason}> }}
 */
export function mergeParas(baseParas, mineParas, theirsParas) {
  const base = indexByKey(baseParas || [])
  const mine = indexByKey(mineParas)
  const theirs = indexByKey(theirsParas || [])
  const conflicts = []
  const result = new Map()

  const consider = (key) => {
    const b = base.get(key) || null
    const m = mine.get(key) || null
    const t = theirs.get(key) || null
    const mineChanged = b ? !m || !sameEdits(m, b) : Boolean(m)
    const theirsChanged = b ? !t || !sameEdits(t, b) : Boolean(t)

    if (m && t) {
      if (!mineChanged) { result.set(key, t); return }
      if (!theirsChanged) { result.set(key, m); return }
      if (sameEdits(m, t)) { result.set(key, m); return }
      conflicts.push({ key, base: b, mine: m, theirs: t, reason: '同一段落被双方修改为不同内容' })
      return
    }
    if (m && !t) {
      // 服务端最新版本里没有该段
      if (!b) { result.set(key, m); return }          // 我方新增，与对方无关 → 保留
      if (mineChanged) {                               // 对方删除、我方修改 → 删改冲突
        conflicts.push({ key, base: b, mine: m, theirs: null, reason: '对方已删除该段落，你做了修改' })
        return
      }
      return // 对方删除、我方未动 → 删除生效（无意见不拦人）
    }
    if (!m && t) {
      if (!b) { result.set(key, t); return }           // 对方新增（我方编辑时还没看到）→ 自动并入
      if (theirsChanged) {                             // 我方删除、对方修改 → 删改冲突
        conflicts.push({ key, base: b, mine: null, theirs: t, reason: '你删除了该段落，对方做了修改' })
        return
      }
      // 我方删除、对方未动 → 删除生效
    }
    // 双方都删：不进结果
  }

  // 顺序以服务端最新版本为骨架（后到者不重排既有段落），新增段按顺序追加
  for (const p of theirsParas || []) consider(p.key)
  for (const p of mineParas) {
    if (!result.has(p.key) && !conflicts.some((cf) => cf.key === p.key)) consider(p.key)
  }
  // base 有、mine/theirs 都没有 → 双方共删，consider 时已自然排除，无需处理

  const ordered = []
  const seen = new Set()
  for (const p of theirsParas || []) {
    if (result.has(p.key)) { ordered.push(result.get(p.key)); seen.add(p.key) }
  }
  for (const p of mineParas) {
    if (result.has(p.key) && !seen.has(p.key)) { ordered.push(result.get(p.key)); seen.add(p.key) }
  }
  return { paras: ordered, conflicts }
}

// 取舍：对每个冲突段二选一（mine/theirs），也可给 custom 文本。
// 选了已被对方删除的一侧（mine/theirs 为 null）表示接受删除（drop=true）。
// 未全部裁决时返回 unresolved，由调用方转 409。
export function resolveConflicts(merged, resolutions = []) {
  const byKey = new Map((resolutions || []).map((r) => [r.key, r]))
  const unresolved = []
  const chosen = []
  for (const cf of merged.conflicts) {
    const r = byKey.get(cf.key)
    if (!r || !r.choice) { unresolved.push(cf.key); continue }
    if (r.choice === 'mine') {
      if (cf.mine) chosen.push({ key: cf.key, pick: 'mine', text: cf.mine.text, tags: cf.mine.tags })
      else chosen.push({ key: cf.key, pick: 'mine', drop: true })
    } else if (r.choice === 'theirs') {
      if (cf.theirs) chosen.push({ key: cf.key, pick: 'theirs', text: cf.theirs.text, tags: cf.theirs.tags })
      else chosen.push({ key: cf.key, pick: 'theirs', drop: true })
    } else if (r.choice === 'custom' && normText(r.text)) {
      chosen.push({ key: cf.key, pick: 'custom', text: normText(r.text), tags: normTags(r.tags) })
    } else unresolved.push(cf.key)
  }
  return { resolved: chosen, unresolved }
}

/**
 * 两版段落差异（版本链「看前后差异」用），按 key 对齐。
 * @returns [{ key, status: 'same'|'changed'|'added'|'removed', from, to }]
 */
export function diffParas(fromParas, toParas) {
  const from = indexByKey(fromParas || [])
  const to = indexByKey(toParas || [])
  const out = []
  for (const p of toParas || []) {
    const f = from.get(p.key)
    if (!f) out.push({ key: p.key, status: 'added', from: null, to: p })
    else if (sameEdits(f, p)) out.push({ key: p.key, status: 'same', from: f, to: p })
    else out.push({ key: p.key, status: 'changed', from: f, to: p })
  }
  for (const p of fromParas || []) {
    if (!to.has(p.key)) out.push({ key: p.key, status: 'removed', from: p, to: null })
  }
  return out
}

// 差异统计摘要（保存后回显 / 版本列表角标）
export function diffSummary(diff) {
  const s = { added: 0, removed: 0, changed: 0, same: 0 }
  for (const d of diff) s[d.status]++
  return s
}
