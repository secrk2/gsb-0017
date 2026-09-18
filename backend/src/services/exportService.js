import { getDashboard } from './dashboardService.js'

// CSV 导出：完成度数字直接取作战台聚合（同一 lib/completion 口径），
// 与作战台、案件详情三处一致，不另起算法。
function csvCell(v) {
  const s = v == null ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export async function exportCasesCsv(user) {
  const dash = await getDashboard(user)
  const header = [
    '案件号', '案件名称', '客户（脱敏口径与界面一致）', '案件类型', '当前状态',
    '关键阶段完成数', '关键阶段总数', '关键阶段完成度%', '关键阶段口径',
    '已归档官文数', '官文总数', '官文归档完成度%', '官文口径',
  ]
  const lines = [header.map(csvCell).join(',')]
  for (const c of dash.completion.cases) {
    lines.push([
      c.case_no, c.case_title, c.client_name, c.ctype, c.status,
      c.stage.done, c.stage.total, c.stage.percent, dash.completion.stage_label,
      c.doc.done, c.doc.total, c.doc.percent, dash.completion.doc_label,
    ].map(csvCell).join(','))
  }
  // 首行口径说明 + UTF-8 BOM（Excel 直接打开不乱码）
  const note = `# 代理所时区：${dash.firm_tz}｜口径：${dash.completion.stage_label}；${dash.completion.doc_label}｜导出基准日（代理所今日）：${dash.server_today}`
  return '﻿' + note + '\n' + lines.join('\n')
}
