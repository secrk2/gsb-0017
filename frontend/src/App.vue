<template>
  <div>
    <OfflineBanner />
    <TopBar v-if="store.user" />
    <main class="page">
      <router-view />
    </main>
    <div v-if="store.toast" class="toast" :class="store.toast.type">{{ store.toast.message }}</div>
  </div>
</template>

<script setup>
import { store } from './store.js'
import TopBar from './components/TopBar.vue'
import OfflineBanner from './components/OfflineBanner.vue'
</script>
