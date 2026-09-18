import { config } from './config.js'

let driver = null

export async function initDb() {
  if (config.dbDialect === 'sqlite') {
    const { createSqliteDriver } = await import('./drivers/sqlite.js')
    driver = createSqliteDriver(config.sqliteFile)
  } else {
    const { createMysqlDriver } = await import('./drivers/mysql.js')
    driver = await createMysqlDriver(config.db)
  }
  return driver
}

// MySQL 容器启动较慢，compose 虽有 healthcheck，这里仍做重试兜底
export async function waitForDb(retries = 30, delayMs = 2000) {
  let lastErr
  for (let i = 0; i < retries; i++) {
    try {
      await driver.ping()
      return
    } catch (e) {
      lastErr = e
      await new Promise((r) => setTimeout(r, delayMs))
    }
  }
  throw lastErr
}

export function query(sql, params = []) {
  return driver.query(sql, params)
}

export function insert(sql, params = []) {
  return driver.insert(sql, params)
}

export function tx(fn) {
  return driver.tx(fn)
}

export async function closeDb() {
  if (driver) await driver.close()
}

// 两种驱动的唯一约束冲突错误归一化
export function isDupErr(e) {
  return (
    e?.code === 'ER_DUP_ENTRY' ||
    e?.errno === 1062 ||
    /UNIQUE constraint failed/i.test(e?.message || '')
  )
}
