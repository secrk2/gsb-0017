// 客户名脱敏：立项后（存在非「委托中」案件）对所内人员展示为「缩写·编号」，
// 全称需二次确认并填写理由后单独获取，且每次查看都会留痕（见 routes/clients.js 的 reveal）。

export const maskedName = (client) => `${client.short_code}·${client.code}`

const FIRM_ROLES = ['admin', 'agent', 'reviewer']

export function isFirmRole(role) {
  return FIRM_ROLES.includes(role)
}

// 客户维度：有任何案件走过立项即脱敏
export function maskClientForViewer(client, viewer, activeCaseCount) {
  if (!isFirmRole(viewer.role)) return { ...client, masked: false }
  if (!activeCaseCount) return { ...client, masked: false }
  return {
    id: client.id,
    code: client.code,
    short_code: client.short_code,
    name: maskedName(client),
    masked: true,
    contact_name: client.contact_name,
    contact_phone: client.contact_phone,
    contact_email: client.contact_email,
    status: client.status,
    created_at: client.created_at,
  }
}

// 案件维度：该案件一旦越过「委托中」即脱敏
export function maskCaseClientName(caseRow, clientRow, viewer) {
  if (!isFirmRole(viewer.role)) return { name: clientRow.name, masked: false }
  if (caseRow.status === '委托中') return { name: clientRow.name, masked: false }
  return { name: maskedName(clientRow), masked: true }
}
