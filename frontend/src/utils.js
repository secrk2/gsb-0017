export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

export function fmtDate(s) {
  return s ? String(s).slice(0, 10) : '—'
}

export function fmtDateTime(s) {
  if (!s) return '—'
  if (typeof s === 'number') {
    const d = new Date(s)
    const p = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  }
  return String(s).slice(0, 16)
}

export function fmtMoney(n) {
  return `¥${Number(n || 0).toLocaleString('zh-CN', { minimumFractionDigits: 0 })}`
}

// 整数日差：b - a（YYYY-MM-DD，按 UTC 午夜解析，与后端 daysBetween 一致）
export function dayDiff(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000)
}

// 到期日 → 徽标文案与样式。
// today 必须传服务端给的「代理所今日」（completion.server_today / calendar.server_today）；
// 不传时退化为 UTC 今日，但跨时区「剩几天」可能差一天，界面一律优先传服务端日。
export function dday(dueDate, today) {
  const t = today || new Date().toISOString().slice(0, 10)
  const diff = dayDiff(t, dueDate)
  if (diff < 0) return { text: `逾期${-diff}天`, cls: 'bad' }
  if (diff === 0) return { text: '今天到期', cls: 'bad' }
  if (diff <= 3) return { text: `D-${diff}`, cls: 'bad' }
  if (diff <= 7) return { text: `D-${diff}`, cls: 'warn' }
  return { text: `D-${diff}`, cls: 'ok' }
}

export const ANCHOR_TEXT = { receive: '自收到日', dispatch: '自发文日' }
export const BASIS_TEXT = {
  natural: '自然日',
  workday: '工作日',
  legal: '法定顺延',
}
export const BASIS_HINT = {
  natural: '自然日：到期日不做节假日顺延。',
  workday: '工作日：不含周末及法定节假日，调休补班日照常计入。',
  legal: '法定口径：自然日届满，届满日逢休息日/法定节假日顺延至下一工作日。',
}
export const DOC_STATUS_TEXT = { 已登记: '半截·已登记', 已归档: '已归档', 已撤回: '已撤回' }
export const DOC_STATUS_CHIP = { 已登记: 'warn', 已归档: 'ok', 已撤回: 'bad' }
