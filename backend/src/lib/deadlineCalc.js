// 期限计算（纯函数，服务层与测试共用）。
//
// 三种天数口径：
//   natural 自然日：起算日次日为第 1 日，直接加 N 个日历日，不做任何顺延；
//   workday 工作日：自起算日次日起数 N 个工作日（跳过周六日与法定节假日，调休补班日计入）；
//   legal   法定节假日顺延：先按自然日算出届满日，届满日落在休息日/法定节假日的，
//           依法顺延至其后第一个工作日（《专利法实施细则》期限口径）。
//
// 起算日不计入期限（自起算日次日开始数），与代理人实务一致。
// calendar: { holidays: Set<string>, workdays: Set<string> }，来自 holidays 表
//   holidays  = 国务院公布的放假休息日；workdays = 调休补班（周末但上班）。

import { addDays, isWeekend, parseDate, daysBetween, fmtDate } from './dates.js'

export const DAY_BASES = ['natural', 'workday', 'legal']
export const ANCHORS = ['receive', 'dispatch']

export function isWorkday(dateStr, cal) {
  if (cal?.workdays?.has(dateStr)) return true
  if (cal?.holidays?.has(dateStr)) return false
  const w = parseDate(dateStr).getUTCDay()
  return w !== 0 && w !== 6
}

// 下一个工作日（调休补班日照常计入）
export function nextWorkday(dateStr, cal) {
  let d = dateStr
  let guard = 0
  while (!isWorkday(d, cal) && guard++ < 30) d = addDays(d, 1)
  return d
}

/**
 * 计算到期日。
 * @param {object} p { start_date: 'YYYY-MM-DD', duration_days: number, day_basis }
 * @returns {{due_date:string, rolled:boolean, basis:string, counted:number}}
 */
export function computeDueDate({ start_date, duration_days, day_basis = 'natural' }, cal = { holidays: new Set(), workdays: new Set() }) {
  const n = Math.max(0, Math.trunc(Number(duration_days) || 0))
  if (day_basis === 'workday') {
    let d = addDays(start_date, 1) // 起算日次日开始数
    if (!isWorkday(d, cal)) d = nextWorkday(d, cal)
    let counted = 1
    while (counted < n) {
      d = addDays(d, 1)
      if (isWorkday(d, cal)) counted++
    }
    return { due_date: d, rolled: false, basis: day_basis, counted: n }
  }
  // natural / legal 都先按自然日届满
  let due = addDays(start_date, n)
  if (day_basis === 'legal') {
    if (!isWorkday(due, cal)) {
      const rolled = nextWorkday(due, cal)
      return { due_date: rolled, rolled: rolled !== due, basis: day_basis, counted: n }
    }
  }
  return { due_date: due, rolled: false, basis: day_basis, counted: n }
}

// 剩余天数：按代理所今日（YYYY-MM-DD）与到期日做整日差；负数即已逾期。
export function daysLeft(dueDate, todayStr) {
  return daysBetween(todayStr, dueDate)
}

// 工作日口径下「实际经过/剩余工作日数」（用于界面口径说明，可选）
export function countWorkdaysBetween(a, b, cal) {
  const sign = a <= b ? 1 : -1
  let cur = a
  let n = 0
  while (cur !== b && n < 10000) {
    cur = addDays(cur, sign)
    if (isWorkday(cur, cal)) n++
  }
  return sign * n
}

// 生成日历区间内每一天的工作日/节假日标记（日历视图用）
export function markRange(from, to, cal) {
  const out = []
  let cur = from
  let guard = 0
  while (cur <= to && guard++ < 400) {
    out.push({ date: cur, workday: isWorkday(cur, cal), weekend: isWeekend(cur), holiday: cal?.holidays?.has(cur) || false })
    cur = addDays(cur, 1)
  }
  return out
}

export function basisHint(day_basis) {
  return {
    natural: '自然日口径：到期日不做节假日顺延',
    workday: '工作日口径：不含周末及法定节假日，调休补班日照常计入',
    legal: '法定口径：自然日届满，届满日逢休息日/法定节假日顺延至下一工作日',
  }[day_basis]
}

export { fmtDate }
