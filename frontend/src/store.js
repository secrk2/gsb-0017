import { reactive } from 'vue'

export const store = reactive({
  token: localStorage.getItem('pc_token') || '',
  user: JSON.parse(localStorage.getItem('pc_user') || 'null'),
  online: navigator.onLine,
  outboxCount: 0,
  toast: null,
  setAuth(token, user) {
    this.token = token
    this.user = user
    localStorage.setItem('pc_token', token)
    localStorage.setItem('pc_user', JSON.stringify(user))
  },
  logout() {
    this.token = ''
    this.user = null
    localStorage.removeItem('pc_token')
    localStorage.removeItem('pc_user')
  },
  showToast(message, type = 'info') {
    const id = Date.now() + Math.random()
    this.toast = { id, message, type }
    setTimeout(() => {
      if (this.toast?.id === id) this.toast = null
    }, 4500)
  },
})

export const isFirm = () => ['admin', 'agent', 'reviewer'].includes(store.user?.role)

export const roleName = (r) =>
  ({ admin: '管理员', agent: '代理人', reviewer: '审核员', client_admin: '客户管理员' })[r] || r
