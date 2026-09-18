import { query } from '../db.js'

// 法定节假日日历。表很小，全量读出后由期限引擎做内存判定；
// 缺失年份的日期按普通周末规则处理（seed 预置了当前年度安排）。
export async function getCalendar() {
  const rows = await query('SELECT date, kind FROM holidays')
  const holidays = new Set()
  const workdays = new Set()
  for (const r of rows) {
    if (r.kind === 'workday') workdays.add(r.date)
    else holidays.add(r.date)
  }
  return { holidays, workdays }
}

// 区间内的节假日/补班清单（日历视图用于角标）
export async function listHolidays(from, to) {
  if (!from || !to) return query("SELECT date, kind, name FROM holidays ORDER BY date")
  return query('SELECT date, kind, name FROM holidays WHERE date BETWEEN ? AND ? ORDER BY date', [from, to])
}
