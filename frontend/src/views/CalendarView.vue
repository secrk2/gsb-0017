<template>
  <div>
    <div class="spread">
      <h2 style="margin: 0; font-size: 18px">官文与期限日历</h2>
      <div class="row">
        <div class="seg">
          <button :class="view === 'month' ? 'on' : ''" @click="setView('month')">月视图</button>
          <button :class="view === 'week' ? 'on' : ''" @click="setView('week')">周视图</button>
        </div>
        <div class="seg">
          <button :class="basis === 'dispatch' ? 'on' : ''" @click="basis = 'dispatch'">按发文日</button>
          <button :class="basis === 'receive' ? 'on' : ''" @click="basis = 'receive'">按收到日</button>
        </div>
      </div>
    </div>

    <div class="card cal-toolbar mt16">
      <button class="btn sm" @click="shift(-1)">‹ 上一{{ view === 'month' ? '月' : '周' }}</button>
      <button class="btn sm" @click="goToday">今天</button>
      <button class="btn sm" @click="shift(1)">下一{{ view === 'month' ? '月' : '周' }} ›</button>
      <strong style="margin-left: 4px">{{ rangeLabel }}</strong>
      <span class="small muted">（{{ basis === 'dispatch' ? '官文按发文日落点；无发文日的不显示' : '官文按收到日落点，缺实际收到日按发文日+15日推定' }}）</span>
      <span class="small muted" style="margin-left: auto">代理所今日：{{ serverToday }}</span>
    </div>

    <!-- 加载失败：独立错误态，可重试 -->
    <div v-if="error" class="card mt16">
      <ErrorState :code="errorCode === 0 ? 'NETWORK' : 'ERROR'" :message="error" />
      <div class="row" style="justify-content: center; margin-top: -30px">
        <button class="btn primary" @click="load">重新加载</button>
      </div>
    </div>

    <template v-else>
      <!-- 区间内无任何落点：独立空态，不与加载失败混用 -->
      <div v-if="loaded && !hasAnyItem" class="card mt16 inline-empty">
        <div class="ie-icon">🗓️</div>
        <p class="ie-title">本区间无官文与期限落点</p>
        <p class="small muted">{{ rangeLabel }} 内没有{{ basis === 'dispatch' ? '发文' : '收到' }}的官文，也没有到期的期限。可切换月/周或调整落点口径查看。</p>
      </div>

      <!-- ============ 桌面：整月/整周网格 ============ -->
      <div v-else-if="device === 'desktop'" class="card mt16">
        <div class="cal-grid">
          <div v-for="w in weekDays" :key="w" class="cal-dow">{{ w }}</div>
        </div>
        <div class="cal-grid mt8">
          <div
            v-for="day in gridDays"
            :key="day.date"
            class="cal-cell"
            :class="{ outside: !day.inRange, today: day.isToday, holiday: day.holiday }"
            :style="{ minHeight: view === 'week' ? '340px' : '96px' }"
            @click="selected = day.date"
          >
            <div class="cal-date">
              {{ day.label }}
              <span v-if="day.holidayName" class="holiday-tag">{{ day.holidayName }}</span>
              <span v-else-if="day.isWorkdaySwap" class="holiday-tag" style="color: var(--ok)">班</span>
            </div>
            <div class="cal-items">
              <div
                v-for="it in day.items.slice(0, view === 'week' ? 20 : 3)"
                :key="it.key"
                class="cal-item"
                :class="itemCls(it)"
                :title="it.title"
                @click.stop="openCase(it.case_id)"
              >{{ it.title }}</div>
              <div v-if="day.items.length > (view === 'week' ? 20 : 3)" class="cal-more">+{{ day.items.length - 3 }} 更多</div>
            </div>
          </div>
        </div>
        <p class="small muted mt8">
          蓝条＝官文{{ basis === 'dispatch' ? '发文' : '收到' }}；黄条＝期限到期；红条＝已逾期；删除线＝已撤回官文。点击事项跳转案件。
        </p>
      </div>

      <!-- ============ 平板：左日历 + 右当日事项两栏 ============ -->
      <div v-else-if="device === 'tablet'" class="cal-split mt16">
        <div class="card">
          <div class="cal-grid">
            <div v-for="w in weekDays" :key="w" class="cal-dow">{{ w }}</div>
          </div>
          <div class="cal-grid mt8">
            <div
              v-for="day in gridDays"
              :key="day.date"
              class="cal-cell"
              :class="{ outside: !day.inRange, today: day.isToday, holiday: day.holiday, selected: day.date === selected }"
              style="min-height: 70px"
              @click="selected = day.date"
            >
              <div class="cal-date">
                {{ day.label }}
                <span v-if="day.holidayName" class="holiday-tag">{{ day.holidayName }}</span>
              </div>
              <div class="cal-items">
                <div
                  v-for="it in day.items.slice(0, 2)"
                  :key="it.key"
                  class="cal-item"
                  :class="itemCls(it)"
                  @click.stop="openCase(it.case_id)"
                >{{ it.title }}</div>
                <span v-if="day.items.length > 2" class="cal-more">+{{ day.items.length - 2 }}</span>
              </div>
            </div>
          </div>
        </div>
        <div class="card">
          <div class="spread">
            <h3 style="margin: 0">{{ selectedLabel }} 事项</h3>
            <span v-if="selectedHoliday" class="chip bad">{{ selectedHoliday }}</span>
          </div>
          <div v-if="selectedItems.length" class="mt8">
            <div
              v-for="it in selectedItems"
              :key="it.key"
              class="agenda-item"
              :class="itemCls(it)"
              @click="openCase(it.case_id)"
            >
              <div class="spread">
                <strong>{{ it.title }}</strong>
                <span class="chip" :class="itemCls(it)">{{ it.kindLabel }}</span>
              </div>
              <div class="small muted mt8">{{ it.case_no }} · {{ it.case_title }}</div>
              <div class="small muted">{{ it.client_name }}</div>
            </div>
          </div>
          <div v-else class="inline-empty mt8">
            <div class="ie-icon">▫️</div>
            <p class="small muted" style="margin: 4px 0 0">当日无官文/期限落点</p>
          </div>
        </div>
      </div>

      <!-- ============ 手机：竖向议程 ============ -->
      <div v-else class="cal-agenda-list mt16">
        <div v-for="g in phoneGroups" :key="g.date" class="agenda-group">
          <div class="agenda-date spread">
            <span>{{ g.label }}（{{ g.weekday }}）</span>
            <span v-if="g.holidayName" class="chip bad">{{ g.holidayName }}</span>
            <span v-else-if="g.isWorkdaySwap" class="chip ok">调休上班</span>
          </div>
          <template v-if="g.items.length">
            <div
              v-for="it in g.items"
              :key="it.key"
              class="agenda-item"
              :class="itemCls(it)"
              @click="openCase(it.case_id)"
            >
              <div class="spread">
                <strong>{{ it.title }}</strong>
                <span class="chip" :class="itemCls(it)">{{ it.kindLabel }}</span>
              </div>
              <div class="small muted mt8">{{ it.case_no }} · {{ it.case_title }}</div>
            </div>
          </template>
          <p v-else class="small muted" style="margin: 4px 0 0">当日无官文/期限</p>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { get } from '../api.js'
import ErrorState from '../components/ErrorState.vue'

const router = useRouter()
const weekDays = ['一', '二', '三', '四', '五', '六', '日']
const view = ref('month')
const basis = ref('dispatch')
const cursor = ref(utcDateStr(new Date()))
const selected = ref(cursor.value)
const data = ref(null)
const holidays = ref([])
const loaded = ref(false)
const error = ref('')
const errorCode = ref('ERROR')
const device = ref('desktop')

let mqTablet = null
let mqPhone = null

function utcDateStr(d) {
  return d.toISOString().slice(0, 10)
}
function parse(s) {
  return new Date(Date.parse(s + 'T00:00:00Z'))
}
function addDays(s, n) {
  const d = parse(s)
  d.setUTCDate(d.getUTCDate() + n)
  return utcDateStr(d)
}
function mondayOf(s) {
  const d = parse(s)
  const w = (d.getUTCDay() + 6) % 7 // 周一=0
  d.setUTCDate(d.getUTCDate() - w)
  return utcDateStr(d)
}
function monthStart(s) {
  return s.slice(0, 8) + '01'
}
function monthEnd(s) {
  const y = Number(s.slice(0, 4))
  const m = Number(s.slice(5, 7))
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return `${s.slice(0, 8)}${String(last).padStart(2, '0')}`
}

const serverToday = computed(() => data.value?.server_today || cursor.value)

const range = computed(() => {
  if (view.value === 'week') {
    const from = mondayOf(cursor.value)
    return { from, to: addDays(from, 6) }
  }
  const first = monthStart(cursor.value)
  const gridFrom = mondayOf(first)
  const last = monthEnd(cursor.value)
  const gridTo = addDays(mondayOf(last), 6) // 末尾补齐到周日
  // 固定 6 行（42 格），避免月间跳动
  return { from: gridFrom, to: addDays(gridFrom, 41) }
})

const rangeLabel = computed(() => {
  if (view.value === 'week') return `${range.value.from} ~ ${range.value.to}`
  return `${cursor.value.slice(0, 7)}`
})

const holidayMap = computed(() => new Map(holidays.value.map((h) => [h.date, h])))

// 把官文/期限拍平成带落点日期的事项
const itemsByDate = computed(() => {
  const map = new Map()
  const push = (date, it) => {
    if (!map.has(date)) map.set(date, [])
    map.get(date).push(it)
  }
  for (const d of data.value?.docs || []) {
    const date = basis.value === 'dispatch' ? d.dispatch_date : d.receive_date || d.presumed_receive_date
    if (!date) continue
    if (date < range.value.from || date > range.value.to) continue
    push(date, {
      key: `doc-${d.id}`,
      date,
      case_id: d.case_id,
      case_no: d.case_no,
      case_title: d.case_title,
      client_name: d.client_name,
      title: d.doc_type,
      kindLabel: d.status === '已撤回' ? '官文·撤回' : d.status === '已归档' ? '官文·归档' : '官文·已登记',
      kind: 'doc',
      status: d.status,
    })
  }
  for (const d of data.value?.deadlines || []) {
    push(d.due_date, {
      key: `dl-${d.id}`,
      date: d.due_date,
      case_id: d.case_id,
      case_no: d.case_no,
      case_title: d.case_title,
      client_name: d.client_name,
      title: `${d.dtype}${d.overdue ? '（已逾期）' : ''}`,
      kindLabel: d.overdue ? '期限·逾期' : '期限到期',
      kind: 'due',
      overdue: d.overdue,
    })
  }
  return map
})

const hasAnyItem = computed(() => itemsByDate.value.size > 0)

const gridDays = computed(() => {
  const out = []
  let cur = range.value.from
  const monthPrefix = cursor.value.slice(0, 7)
  while (cur <= range.value.to) {
    const h = holidayMap.value.get(cur)
    const items = itemsByDate.value.get(cur) || []
    items.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'due' ? -1 : 1))
    out.push({
      date: cur,
      label: cur.slice(8),
      inRange: cur.slice(0, 7) === monthPrefix || view.value === 'week',
      isToday: cur === serverToday.value,
      holiday: h?.kind === 'holiday',
      isWorkdaySwap: h?.kind === 'workday',
      holidayName: h?.kind === 'holiday' ? h.name : '',
      items,
    })
    cur = addDays(cur, 1)
  }
  return out
})

const selectedItems = computed(() => itemsByDate.value.get(selected.value) || [])
const selectedHoliday = computed(() => holidayMap.value.get(selected.value)?.name || '')
const selectedLabel = computed(() => selected.value)

const phoneGroups = computed(() => {
  // 周视图展示 7 天（含空日）；月视图只展示有事项的日子，按日期升序
  if (view.value === 'week') {
    const out = []
    let cur = range.value.from
    while (cur <= range.value.to) {
      out.push(phoneGroup(cur))
      cur = addDays(cur, 1)
    }
    return out
  }
  return [...itemsByDate.value.keys()].sort().map(phoneGroup)
})
function phoneGroup(date) {
  const h = holidayMap.value.get(date)
  const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][parse(date).getUTCDay()]
  return {
    date,
    label: date,
    weekday: wd,
    holidayName: h?.kind === 'holiday' ? h.name : '',
    isWorkdaySwap: h?.kind === 'workday',
    items: itemsByDate.value.get(date) || [],
  }
}

function itemCls(it) {
  if (it.kind === 'doc') return { doc: true, off: it.status === '已撤回' }
  return { due: true, over: it.overdue }
}

function shift(n) {
  const d = parse(cursor.value)
  if (view.value === 'month') d.setUTCMonth(d.getUTCMonth() + n)
  else d.setUTCDate(d.getUTCDate() + n * 7)
  cursor.value = utcDateStr(d)
}
function goToday() {
  cursor.value = utcDateStr(new Date())
  selected.value = cursor.value
}
function setView(v) {
  view.value = v
  selected.value = cursor.value
}
function openCase(id) {
  router.push(`/cases/${id}`)
}

async function load() {
  error.value = ''
  loaded.value = false
  try {
    const [r, hr] = await Promise.all([
      get(`/calendar?from=${range.value.from}&to=${range.value.to}&basis=${basis.value}`, { cacheKey: `cal:${range.value.from}:${range.value.to}:${basis.value}` }),
      get(`/holidays?from=${range.value.from}&to=${range.value.to}`).catch(() => ({ data: [] })),
    ])
    data.value = r.data
    holidays.value = hr.data
    loaded.value = true
  } catch (e) {
    error.value = e.code === 'NETWORK' ? '日历数据加载失败：当前网络不可用且本地无缓存。联网后点「重新加载」。' : `日历数据加载失败：${e.message}`
    errorCode.value = e.code
  }
}

function syncDevice() {
  if (window.matchMedia('(max-width: 640px)').matches) device.value = 'phone'
  else if (window.matchMedia('(max-width: 1024px)').matches) device.value = 'tablet'
  else device.value = 'desktop'
}

watch([view, cursor, basis], load)
onMounted(() => {
  syncDevice()
  mqTablet = window.matchMedia('(max-width: 1024px)')
  mqPhone = window.matchMedia('(max-width: 640px)')
  mqTablet.addEventListener('change', syncDevice)
  mqPhone.addEventListener('change', syncDevice)
  load()
})
onUnmounted(() => {
  mqTablet?.removeEventListener('change', syncDevice)
  mqPhone?.removeEventListener('change', syncDevice)
})
</script>
