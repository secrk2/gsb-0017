import { createApp } from 'vue'
import App from './App.vue'
import { router } from './router.js'
import { store } from './store.js'
import { flushOutbox, refreshOutboxCount } from './api.js'
import './styles.css'

createApp(App).use(router).mount('#app')

// 应用外壳离线可用
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}))
}

// 恢复网络：回放待同步队列，并通知各页面刷新
window.addEventListener('online', async () => {
  store.online = true
  const results = await flushOutbox()
  if (results) {
    const applied = results.filter((r) => r.status === 'applied').length
    const dup = results.filter((r) => r.status === 'duplicate').length
    const conflicts = results.filter((r) => r.status === 'conflict' || r.status === 'error')
    if (applied || dup) {
      store.showToast(`网络已恢复：同步 ${applied} 条变更${dup ? `，${dup} 条重复已忽略` : ''}`, 'success')
    }
    for (const c of conflicts) {
      store.showToast(`同步冲突：${c.message || c.code}（已保留服务器状态）`, 'error')
    }
    window.dispatchEvent(new CustomEvent('pc:synced'))
  }
})

window.addEventListener('offline', () => {
  store.online = false
})

refreshOutboxCount()
