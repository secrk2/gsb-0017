export class ApiError extends Error {
  constructor(http, code, message, details) {
    super(message)
    this.http = http
    this.code = code
    this.details = details
  }
}

export const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)

export function errorHandler(err, req, res, _next) {
  if (err instanceof ApiError) {
    return res.status(err.http).json({ error: { code: err.code, message: err.message, details: err.details } })
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'BAD_JSON', message: '请求体不是合法 JSON' } })
  }
  console.error('[patent-cloud] unhandled error:', err)
  res.status(500).json({ error: { code: 'INTERNAL', message: '服务器内部错误' } })
}
