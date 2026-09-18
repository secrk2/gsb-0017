import { test } from 'node:test'
import assert from 'node:assert/strict'
import { maskedName, maskClientForViewer, maskCaseClientName } from '../src/lib/mask.js'

const client = {
  id: 1,
  code: 'KH-0001',
  name: '华芯半导体科技有限公司',
  short_code: 'HX',
  contact_name: '王工',
  contact_phone: '138',
  contact_email: 'a@b.c',
  status: '已签约',
  created_at: '2026-01-01 00:00:00',
}

test('脱敏格式为 缩写·编号', () => {
  assert.equal(maskedName(client), 'HX·KH-0001')
})

test('所内角色：有立项后案件 → 脱敏；无 → 明文', () => {
  const masked = maskClientForViewer(client, { role: 'agent' }, 2)
  assert.equal(masked.name, 'HX·KH-0001')
  assert.equal(masked.masked, true)
  assert.equal(masked.name.includes('华芯'), false)
  const plain = maskClientForViewer(client, { role: 'agent' }, 0)
  assert.equal(plain.name, client.name)
  assert.equal(plain.masked, false)
})

test('客户管理员看本客户始终明文', () => {
  const r = maskClientForViewer(client, { role: 'client_admin', client_id: 1 }, 5)
  assert.equal(r.name, client.name)
  assert.equal(r.masked, false)
})

test('案件维度：委托中明文，立项后脱敏', () => {
  const firm = { role: 'reviewer' }
  assert.equal(maskCaseClientName({ status: '委托中' }, client, firm).name, client.name)
  assert.equal(maskCaseClientName({ status: '实审中' }, client, firm).name, 'HX·KH-0001')
  assert.equal(maskCaseClientName({ status: '实审中' }, client, { role: 'client_admin' }).name, client.name)
})
