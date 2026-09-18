import express from 'express'
import { query } from './db.js'
import { redis } from './redis.js'
import { authRequired } from './middleware/auth.js'
import { idempotency } from './middleware/idempotency.js'
import { errorHandler } from './middleware/error.js'
import authRoutes from './routes/auth.js'
import dashboardRoutes from './routes/dashboard.js'
import clientRoutes from './routes/clients.js'
import caseRoutes from './routes/cases.js'
import miscRoutes from './routes/misc.js'
import logRoutes from './routes/logs.js'
import syncRoutes from './routes/sync.js'
import docRoutes from './routes/docs.js'

export function createApp() {
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: '1mb' }))

  app.get('/api/health', async (_req, res) => {
    let db = 'down'
    let cache = 'down'
    try {
      await query('SELECT 1')
      db = 'up'
    } catch {}
    try {
      await redis().ping()
      cache = 'up'
    } catch {}
    res.status(db === 'up' ? 200 : 503).json({ data: { status: db === 'up' ? 'ok' : 'degraded', db, redis: cache } })
  })

  app.use('/api/auth', authRoutes)

  // 以下均需登录；POST 支持 Idempotency-Key 幂等回放
  app.use('/api', authRequired, idempotency)
  app.use('/api/dashboard', dashboardRoutes)
  app.use('/api/clients', clientRoutes)
  app.use('/api/cases', caseRoutes)
  app.use('/api/ops', miscRoutes)
  app.use('/api/logs', logRoutes)
  app.use('/api/sync', syncRoutes)
  app.use('/api', docRoutes)

  app.use('/api', (_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: '接口不存在' } }))
  app.use(errorHandler)
  return app
}
