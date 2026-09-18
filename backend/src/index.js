import { config } from './config.js'
import { initDb, waitForDb } from './db.js'
import { initRedis } from './redis.js'
import { seedIfEmpty } from './seed.js'
import { createApp } from './app.js'

async function main() {
  await initDb()
  await waitForDb()
  await initRedis()
  if (config.seedOnBoot) {
    try {
      await seedIfEmpty()
    } catch (e) {
      console.error('[seed] 初始化数据失败：', e)
      process.exit(1)
    }
  }
  const app = createApp()
  app.listen(config.port, () => {
    console.log(`[patent-cloud] backend listening on :${config.port} (db=${config.dbDialect})`)
  })
}

main().catch((e) => {
  console.error('[patent-cloud] 启动失败：', e)
  process.exit(1)
})
