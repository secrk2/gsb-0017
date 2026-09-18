import mysql from 'mysql2/promise'

// 说明：全项目 SQL 使用可移植子集（? 占位、ISO 字符串日期、无方言函数），
// 因此同一套语句在 MySQL 与 sqlite 开发态下行为一致。
const normParams = (params) => params.map((p) => (p === undefined ? null : p))

export async function createMysqlDriver(cfg) {
  const pool = mysql.createPool({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.name,
    waitForConnections: true,
    connectionLimit: 10,
    charset: 'utf8mb4',
  })
  return {
    async ping() {
      await pool.query('SELECT 1')
    },
    async query(sql, params = []) {
      const [rows] = await pool.query(sql, normParams(params))
      return rows
    },
    async insert(sql, params = []) {
      const [r] = await pool.query(sql, normParams(params))
      return r.insertId
    },
    async tx(fn) {
      const conn = await pool.getConnection()
      try {
        await conn.beginTransaction()
        const d = {
          query: async (s, p = []) => (await conn.query(s, normParams(p)))[0],
          insert: async (s, p = []) => (await conn.query(s, normParams(p)))[0].insertId,
        }
        const out = await fn(d)
        await conn.commit()
        return out
      } catch (e) {
        await conn.rollback()
        throw e
      } finally {
        conn.release()
      }
    },
    async close() {
      await pool.end()
    },
  }
}
