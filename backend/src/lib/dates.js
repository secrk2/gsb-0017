// 统一使用 UTC ISO 字符串存储，MySQL 与 sqlite 下比较行为一致（字典序即时间序）。
// 日期口径：期限日期（发文日/收到日/到期日）是「代理所所在地日历日」，
// 用 YYYY-MM-DD 落库；跨时区比较剩余天数时一律以 tzToday() 取出的代理所今日为准。

export function nowIso(d = new Date()) {
  return d.toISOString().slice(0, 19).replace('T', ' ')
}

// UTC 今日（仅用于不涉及时区的纯日期运算）
export function today(d = new Date()) {
  return d.toISOString().slice(0, 10)
}

// 代理所时区今日（YYYY-MM-DD）。所有「今天/剩几天/是否逾期」的口径以此为准。
// en-CA 环境的 Intl 输出即 YYYY-MM-DD，无需手工拼月日。
export function tzToday(tz = 'Asia/Shanghai', d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d)
}

export function daysFromNow(n, base = new Date()) {
  const d = new Date(base)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

// b - a 的天数（a/b 均为 YYYY-MM-DD，按 UTC 午夜解析）
export function daysBetween(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000)
}

// 解析 YYYY-MM-DD 为 UTC 午夜 Date
export function parseDate(s) {
  return new Date(Date.parse(s + 'T00:00:00Z'))
}

export function fmtDate(d) {
  return d.toISOString().slice(0, 10)
}

export function addDays(s, n) {
  return daysFromNow(n, parseDate(s))
}

// 星期几（0=周日 … 6=周六），按 UTC 日历
export function weekday(s) {
  return parseDate(s).getUTCDay()
}

export function isWeekend(s) {
  const w = weekday(s)
  return w === 0 || w === 6
}
