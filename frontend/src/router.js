import { createRouter, createWebHistory } from 'vue-router'
import { store } from './store.js'

const routes = [
  { path: '/login', component: () => import('./views/LoginView.vue') },
  { path: '/', component: () => import('./views/DashboardView.vue'), meta: { auth: true } },
  { path: '/clients', component: () => import('./views/ClientsView.vue'), meta: { auth: true } },
  { path: '/clients/:id', component: () => import('./views/ClientDetailView.vue'), meta: { auth: true } },
  { path: '/cases', component: () => import('./views/CasesView.vue'), meta: { auth: true } },
  { path: '/cases/:id', component: () => import('./views/CaseDetailView.vue'), meta: { auth: true } },
  { path: '/cases/:id/writing', component: () => import('./views/WritingView.vue'), meta: { auth: true } },
  { path: '/calendar', component: () => import('./views/CalendarView.vue'), meta: { auth: true } },
  { path: '/logs', component: () => import('./views/LogsView.vue'), meta: { auth: true, roles: ['admin', 'reviewer'] } },
  { path: '/403', component: () => import('./views/ForbiddenView.vue') },
  { path: '/:pathMatch(.*)*', component: () => import('./views/NotFoundView.vue') },
]

export const router = createRouter({
  history: createWebHistory(),
  routes,
})

router.beforeEach((to) => {
  if (to.meta.auth && !store.token) return { path: '/login', query: { redirect: to.fullPath } }
  if (to.meta.roles && !to.meta.roles.includes(store.user?.role)) return '/403'
  if (to.path === '/login' && store.token) return '/'
})
