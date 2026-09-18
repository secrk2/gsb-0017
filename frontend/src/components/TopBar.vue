<template>
  <header class="topbar">
    <div class="topbar-inner">
      <div class="brand">专利云<span>案件全生命周期管理</span></div>
      <nav class="nav">
        <router-link to="/" exact-active-class="active">案件作战台</router-link>
        <router-link to="/clients" active-class="active">委托与客户</router-link>
        <router-link to="/cases" active-class="active">案件</router-link>
        <router-link to="/calendar" active-class="active">官文日历</router-link>
        <router-link v-if="canSeeLogs" to="/logs" active-class="active">留痕</router-link>
      </nav>
      <div class="user-chip">
        <span>{{ store.user?.name }}</span>
        <span class="role">{{ roleName(store.user?.role) }}</span>
        <button class="link-btn" @click="onLogout">退出</button>
      </div>
    </div>
  </header>
</template>

<script setup>
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { store, roleName } from '../store.js'
import { logout } from '../api.js'

const router = useRouter()
const canSeeLogs = computed(() => ['admin', 'reviewer'].includes(store.user?.role))

async function onLogout() {
  await logout()
  router.push('/login')
}
</script>
