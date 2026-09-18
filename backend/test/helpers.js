// 测试启动辅助：sqlite 内存库 + 内存 Redis，真实启动完整 Express 应用
process.env.DB_DIALECT = 'sqlite'
process.env.SQLITE_FILE = ':memory:'
process.env.REDIS_URL = 'memory://'
process.env.JWT_SECRET = 'test-secret'
process.env.BCRYPT_ROUNDS = '4'

export async function boot() {
  const { initDb, waitForDb } = await import('../src/db.js')
  const { initRedis } = await import('../src/redis.js')
  const { seedIfEmpty } = await import('../src/seed.js')
  const { createApp } = await import('../src/app.js')
  await initDb()
  await waitForDb()
  await initRedis()
  await seedIfEmpty()
  const app = createApp()
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s))
  })
  return { server, base: `http://127.0.0.1:${server.address().port}` }
}

export async function login(base, username, password = 'Patent@123') {
  const r = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  const j = await r.json()
  if (!r.ok) throw new Error(`login ${username} failed: ${JSON.stringify(j)}`)
  return j.data.token
}

export function api(base, token) {
  async function req(method, path, body, headers = {}) {
    const r = await fetch(`${base}/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const j = await r.json().catch(() => null)
    return { status: r.status, body: j, headers: r.headers }
  }
  return {
    req,
    get: (path) => req('GET', path),
    post: (path, body, headers) => req('POST', path, body, headers),
  }
}
