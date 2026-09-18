import { Router } from 'express'
import { asyncH } from '../middleware/error.js'
import { getDashboard } from '../services/dashboardService.js'
import { exportCasesCsv } from '../services/exportService.js'

const router = Router()

router.get(
  '/',
  asyncH(async (req, res) => {
    res.json({ data: await getDashboard(req.user) })
  })
)

// 案件完成度 CSV 导出（作战台/详情/导出三处同口径）
router.get(
  '/export.csv',
  asyncH(async (req, res) => {
    const csv = await exportCasesCsv(req.user)
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', 'attachment; filename="cases-completion.csv"')
    res.send(csv)
  })
)

export default router
