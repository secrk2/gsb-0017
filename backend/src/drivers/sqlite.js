import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// 开发/测试专用：Node 22 内置 sqlite，零外部依赖即可跑通全部业务逻辑。
// 生产环境（docker compose）使用 MySQL 驱动，两者共享同一份可移植 SQL。
const normParams = (params) => params.map((p) => (p === undefined ? null : p))

export function createSqliteDriver(file) {
  const db = new DatabaseSync(file)
  const schemaPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'schema.sqlite.sql')
  db.exec(readFileSync(schemaPath, 'utf8'))
  return {
    async ping() {
      db.prepare('SELECT 1').get()
    },
    async query(sql, params = []) {
      return db.prepare(sql).all(...normParams(params))
    },
    async insert(sql, params = []) {
      const r = db.prepare(sql).run(...normParams(params))
      return Number(r.lastInsertRowid)
    },
    async tx(fn) {
      db.exec('BEGIN')
      try {
        const d = {
          query: async (s, p = []) => db.prepare(s).all(...normParams(p)),
          insert: async (s, p = []) => Number(db.prepare(s).run(...normParams(p)).lastInsertRowid),
        }
        const out = await fn(d)
        db.exec('COMMIT')
        return out
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
    },
    async close() {
      db.close()
    },
  }
}
