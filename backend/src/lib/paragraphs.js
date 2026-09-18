// 段落级版本 diff 与协同冲突检测（纯函数，服务层与测试共用）。
//
// content 形态见 lib/writing.js：{ sections:[{key,title,paragraphs:[{id,text,sensitive}]}] }
// 段落 id 在版本链内稳定，是对齐的唯一依据。
//
// 协同模型（代理人与客户同时改同一份交底）：
//   B = base    双方共同依据的版本（提交者保存时带的 base_version_id）
//   H = head    链头版本（先来者已保存的改动，incoming）
//   P = pending 后来者本次提交（pending）
// 三段比对：只改一方的段落自动合入；双方都改且改得不一样（含「一方编辑/一方删除」）
// → 段落级冲突，登记后弹取舍界面，绝不静默覆盖，也不靠锁拒绝人。

export function indexSections(content) {
  const m = new Map()
  for (const s of content?.sections || []) {
    const pm = new Map()
    for (const p of s.paragraphs || []) pm.set(p.id, p)
    m.set(s.key, { title: s.title, order: (s.paragraphs || []).map((p) => p.id), map: pm })
  }
  return m
}

// 两版差异：按段落 id 对齐，输出 added / removed / modified / equal。
// 顺序以 target 为准，被删除的段落附在该节末尾（保留 base_text 供差异视图）。
export function diffContent(base, target) {
  const bi = indexSections(base)
  const ti = indexSections(target)
  const keys = new Set([...bi.keys(), ...ti.keys()])
  const sections = []
  let changed = 0
  for (const key of keys) {
    const b = bi.get(key)
    const t = ti.get(key)
    const items = []
    for (const pid of t?.order || []) {
      const tp = t.map.get(pid)
      const bp = b?.map.get(pid)
      if (!bp) items.push({ change: 'added', paragraph_id: pid, base_text: '', target_text: tp.text })
      else if (bp.text !== tp.text) items.push({ change: 'modified', paragraph_id: pid, base_text: bp.text, target_text: tp.text })
      else items.push({ change: 'equal', paragraph_id: pid, base_text: bp.text, target_text: tp.text })
    }
    for (const pid of b?.order || []) {
      if (t?.map.has(pid)) continue
      const bp = b.map.get(pid)
      items.push({ change: 'removed', paragraph_id: pid, base_text: bp.text, target_text: '' })
    }
    const sectionChanged = items.filter((i) => i.change !== 'equal').length
    changed += sectionChanged
    sections.push({
      key,
      title: t?.title || b?.title || key,
      changed: sectionChanged,
      items,
    })
  }
  return { changed, sections }
}

function stateOf(sec, id) {
  if (!sec) return { present: false }
  const p = sec.map.get(id)
  return p ? { present: true, text: p.text, sensitive: Boolean(p.sensitive) } : { present: false }
}

// 单段三路合并：返回 {action: 'take'|'delete'|'conflict', text, base,incoming,pending}
function mergeParagraph(id, B, H, P) {
  const b = stateOf(B, id)
  const h = stateOf(H, id)
  const p = stateOf(P, id)
  const same = (x, y) => x.present === y.present && (!x.present || x.text === y.text)

  if (b.present) {
    if (same(h, b) && same(p, b)) return { action: 'take', text: b.text, sensitive: b.sensitive }
    // 仅一方改动
    if (same(h, b) && p.present) return { action: 'take', text: p.text, sensitive: p.sensitive || b.sensitive }
    if (same(p, b) && h.present) return { action: 'take', text: h.text, sensitive: h.sensitive || b.sensitive }
    if (same(h, b) && !p.present) return { action: 'delete' }
    if (same(p, b) && !h.present) return { action: 'delete' }
    // 双方都动了
    if (!h.present && !p.present) return { action: 'delete' }
    if (h.present && p.present && h.text === p.text) return { action: 'take', text: h.text, sensitive: h.sensitive || p.sensitive || b.sensitive }
    // 编辑/编辑不一致，或编辑/删除相向 → 冲突
    return {
      action: 'conflict',
      base_text: b.text,
      incoming_text: h.present ? h.text : null,   // null = 先来者删除了该段
      pending_text: p.present ? p.text : null,    // null = 后来者删除了该段
      incoming_deleted: !h.present,
      pending_deleted: !p.present,
    }
  }
  // 基线不存在：双方各自新增
  if (h.present && !p.present) return { action: 'take', text: h.text, sensitive: h.sensitive }
  if (!h.present && p.present) return { action: 'take', text: p.text, sensitive: p.sensitive }
  if (h.present && p.present && h.text === p.text) return { action: 'take', text: h.text, sensitive: h.sensitive || p.sensitive }
  if (h.present && p.present) {
    return { action: 'conflict', base_text: '', incoming_text: h.text, pending_text: p.text, incoming_deleted: false, pending_deleted: false }
  }
  return { action: 'delete' }
}

/**
 * 三路合并。
 * @param {object} meta 可选 { incomingActorName, pendingActorName, sectionTitles }
 * @returns {{merged:object, conflicts:Array, autoMerged:number}}
 */
export function threeWayMerge(base, incoming, pending, meta = {}) {
  const bi = indexSections(base)
  const hi = indexSections(incoming)
  const pi = indexSections(pending)
  const keys = new Set([...bi.keys(), ...hi.keys(), ...pi.keys()])
  const conflicts = []
  const mergedSections = []
  let autoMerged = 0

  for (const key of keys) {
    const B = bi.get(key)
    const H = hi.get(key)
    const P = pi.get(key)
    const title = P?.title || H?.title || B?.title || key
    const order = []
    const chosen = new Map() // id → {text,sensitive}
    const deleted = new Set()

    const consider = (id) => {
      const r = mergeParagraph(id, B, H, P)
      if (r.action === 'delete') {
        deleted.add(id)
      } else if (r.action === 'take') {
        if (!chosen.has(id) && !order.includes(id)) order.push(id)
        chosen.set(id, { text: r.text, sensitive: r.sensitive })
        if (!B?.map.has(id) || r.text !== (B.map.get(id)?.text)) autoMerged++
      } else {
        // 冲突段落先按先来者文本占位（取舍界面可改），并登记
        if (!order.includes(id)) order.push(id)
        chosen.set(id, {
          text: r.incoming_text ?? r.pending_text ?? r.base_text,
          sensitive: H?.map.get(id)?.sensitive || P?.map.get(id)?.sensitive || B?.map.get(id)?.sensitive || false,
          conflict: true,
        })
        conflicts.push({
          section_key: key,
          paragraph_id: id,
          base_text: r.base_text,
          incoming_text: r.incoming_text,
          pending_text: r.pending_text,
          incoming_deleted: r.incoming_deleted,
          pending_deleted: r.pending_deleted,
          incoming_actor_name: meta.incomingActorName || '',
          pending_actor_name: meta.pendingActorName || '',
        })
      }
    }

    // 顺序：基线 → 先来者新增 → 后来者新增，尽量贴近各方阅读顺序
    for (const id of B?.order || []) consider(id)
    for (const id of H?.order || []) if (!B?.map.has(id)) consider(id)
    for (const id of P?.order || []) if (!B?.map.has(id) && !H?.map.has(id)) consider(id)

    mergedSections.push({
      key,
      title,
      paragraphs: order.filter((id) => !deleted.has(id)).map((id) => ({ id, ...chosen.get(id) })),
    })
  }

  return { merged: { sections: mergedSections }, conflicts, autoMerged }
}
