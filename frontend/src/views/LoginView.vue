<template>
  <div class="login-wrap">
    <div class="card login-card">
      <h1>专利云</h1>
      <p class="muted" style="margin-top: 0">案件全生命周期管理平台</p>
      <div class="field">
        <label>用户名</label>
        <input v-model="username" placeholder="请输入用户名" @keyup.enter="submit" />
      </div>
      <div class="field">
        <label>密码</label>
        <input v-model="password" type="password" placeholder="请输入密码" @keyup.enter="submit" />
      </div>
      <p v-if="error" class="small" style="color: var(--bad)">{{ error }}</p>
      <button class="btn primary" style="width: 100%; justify-content: center" :disabled="loading" @click="submit">
        {{ loading ? '登录中…' : '登 录' }}
      </button>
      <p class="small muted mt16" style="margin-bottom: 6px">演示账号（密码均为 <code>Patent@123</code>）：</p>
      <div class="demo-accounts">
        <button v-for="a in demo" :key="a.u" class="btn" @click="fill(a.u)">
          <strong>{{ a.u }}</strong><br /><span class="muted">{{ a.d }}</span>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { login } from '../api.js'

const router = useRouter()
const route = useRoute()
const username = ref('')
const password = ref('')
const error = ref('')
const loading = ref(false)

const demo = [
  { u: 'admin', d: '管理员 · 周正' },
  { u: 'agent01', d: '代理人 · 李慕华' },
  { u: 'reviewer01', d: '审核员 · 郑严' },
  { u: 'client01', d: '客户管理员 · 华芯' },
]

function fill(u) {
  username.value = u
  password.value = 'Patent@123'
}

async function submit() {
  if (!username.value || !password.value) {
    error.value = '请输入用户名和密码'
    return
  }
  loading.value = true
  error.value = ''
  try {
    await login(username.value, password.value)
    router.push(route.query.redirect || '/')
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}
</script>
