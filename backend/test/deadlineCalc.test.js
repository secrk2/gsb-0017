import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeDueDate, isWorkday, nextWorkday, daysLeft, countWorkdaysBetween } from '../src/lib/deadlineCalc.js'

// 2026 春节：2/15(日)-2/23(一) 放假 9 天；2/14(六)、2/28(六) 调休补班
const holidays = new Set([
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
  '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07',
])
const workdays = new Set(['2026-02-14', '2026-02-28', '2026-09-20', '2026-10-10'])
const cal = { holidays, workdays }

test('自然日口径：直接加天数，周末/节假日均不顺延', () => {
  const r = computeDueDate({ start_date: '2026-02-13', duration_days: 10, day_basis: 'natural' }, cal)
  assert.equal(r.due_date, '2026-02-23') // 正落在春节假期内，自然日不顺延
  assert.equal(r.rolled, false)
})

test('法定口径：届满日落春节假期，顺延至节后第一个工作日 2/24', () => {
  const r = computeDueDate({ start_date: '2026-02-13', duration_days: 10, day_basis: 'legal' }, cal)
  assert.equal(r.due_date, '2026-02-24') // 2/24 周二
  assert.equal(r.rolled, true)
})

test('法定口径：届满日为调休补班周六 2/14，视为工作日不顺延', () => {
  const r = computeDueDate({ start_date: '2026-02-04', duration_days: 10, day_basis: 'legal' }, cal)
  assert.equal(r.due_date, '2026-02-14')
  assert.equal(r.rolled, false)
})

test('法定口径：届满日落普通周末，顺延到周一', () => {
  // 2026-03-07 为周六，+10 自然日自 2/25(周三) → 3/7(六) → 顺延 3/9(周一)
  const r = computeDueDate({ start_date: '2026-02-25', duration_days: 10, day_basis: 'legal' }, cal)
  assert.equal(r.due_date, '2026-03-09')
  assert.equal(r.rolled, true)
})

test('法定口径：届满日是工作日则不顺延（国庆前 9/30）', () => {
  const r = computeDueDate({ start_date: '2026-09-20', duration_days: 10, day_basis: 'legal' }, cal)
  assert.equal(r.due_date, '2026-09-30')
  assert.equal(r.rolled, false)
})

test('法定口径：届满落国庆 7 天假期首日 10/1，顺延至节后首个工作日 10/8（周四）', () => {
  const r = computeDueDate({ start_date: '2026-09-24', duration_days: 7, day_basis: 'legal' }, cal)
  assert.equal(r.due_date, '2026-10-08')
  assert.equal(r.rolled, true)
})

test('工作日口径：跨春节 9 天假，5 个工作日落在节后 2/26（2/24、25、26 + 2/27 + 2/28补班）', () => {
  // 起算日 2/12(周四)，次日 2/13(周五)=第1个；2/14补班=第2个；假期跳过；2/24=3,2/25=4,2/26=5
  const r = computeDueDate({ start_date: '2026-02-12', duration_days: 5, day_basis: 'workday' }, cal)
  assert.equal(r.due_date, '2026-02-26')
})

test('工作日口径：调休补班日照常计入（起算次日即 2/14 周六补班）', () => {
  // 起算日 2/13 周五，次日 2/14 补班=第1个
  const r = computeDueDate({ start_date: '2026-02-13', duration_days: 1, day_basis: 'workday' }, cal)
  assert.equal(r.due_date, '2026-02-14')
})

test('工作日口径：普通周末跳过', () => {
  // 2026-03-05 周四起算，次日周五=1，3/9 周一=2
  const r = computeDueDate({ start_date: '2026-03-05', duration_days: 2, day_basis: 'workday' }, cal)
  assert.equal(r.due_date, '2026-03-09')
})

test('起算日不计入期限：1 天期限=起算日次日', () => {
  const r = computeDueDate({ start_date: '2026-09-16', duration_days: 1, day_basis: 'natural' }, cal)
  assert.equal(r.due_date, '2026-09-17')
})

test('isWorkday/nextWorkday 组合规则', () => {
  assert.equal(isWorkday('2026-02-14', cal), true)  // 周六但调休
  assert.equal(isWorkday('2026-02-15', cal), false) // 春节
  assert.equal(isWorkday('2026-02-28', cal), true)  // 周六调休
  assert.equal(isWorkday('2026-03-07', cal), false) // 普通周六
  assert.equal(isWorkday('2026-03-09', cal), true)  // 周一
  assert.equal(nextWorkday('2026-02-15', cal), '2026-02-24')
})

test('daysLeft 剩余天数：逾期为负，今天为 0', () => {
  assert.equal(daysLeft('2026-09-17', '2026-09-17'), 0)
  assert.equal(daysLeft('2026-09-20', '2026-09-17'), 3)
  assert.equal(daysLeft('2026-09-10', '2026-09-17'), -7)
})

test('无日历数据时退化为普通周末规则，不报错', () => {
  assert.equal(isWorkday('2026-02-14', {}), false) // 没有调休表，普通周六
  const r = computeDueDate({ start_date: '2026-02-25', duration_days: 10, day_basis: 'legal' }, {})
  assert.equal(r.due_date, '2026-03-09')
})

test('countWorkdaysBetween 跨春节统计：2/14 补班、2/24 复工，共 2 个工作日', () => {
  assert.equal(countWorkdaysBetween('2026-02-13', '2026-02-24', cal), 2)
})
