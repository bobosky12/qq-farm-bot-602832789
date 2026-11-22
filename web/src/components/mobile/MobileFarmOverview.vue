<script setup lang="ts">
/**
 * 手机端「总览」页：农场概览的移动版布局（卡片式）。
 *
 * 只在 < md 断点显示，桌面端沿用 Dashboard 原有布局。
 * 数据全部复用 layout 里已经加载的 store，不额外发请求：
 *  - 账号 / 在线 / 等级 / 经验 / 升级预测：account + status store
 *  - 化肥容器：bag store 的 dashboardItems（与 PC 版同一份）
 */
import { storeToRefs } from 'pinia'
import { computed, ref } from 'vue'
import { getPlatformLabel, useAccountStore } from '@/stores/account'
import { useBagStore } from '@/stores/bag'
import { useStatusStore } from '@/stores/status'

const accountStore = useAccountStore()
const bagStore = useBagStore()
const statusStore = useStatusStore()

const { currentAccount } = storeToRefs(accountStore)
const { dashboardItems } = storeToRefs(bagStore)
const { status, diamondBalance, logs: _statusLogs } = storeToRefs(statusStore)

const failedAvatar = ref('')

const isOnline = computed(() => !!currentAccount.value?.running && status.value?.connection?.connected === true)
const level = computed(() => Number(status.value?.status?.level) || 0)

const displayName = computed(() => {
  const account = currentAccount.value
  const gameName = String(status.value?.status?.name || '').trim()
  if (gameName) {
    const remark = String(account?.remark || '').trim()
    return remark && remark !== gameName ? `${gameName}（${remark}）` : gameName
  }
  return String(account?.nick || account?.name || '我的农场')
})

const avatar = computed(() => {
  const account = currentAccount.value
  const live = String(status.value?.accountId || '') === String(account?.id || '')
    ? String(status.value?.status?.avatarUrl || '').trim()
    : ''
  return live || String(account?.avatar || '').trim()
})

const platformLabel = computed(() => getPlatformLabel(currentAccount.value?.platform))

const levelProgress = computed(() => status.value?.levelProgress)
const expCurrent = computed(() => formatPlainNumber(levelProgress.value?.current))
const expNeeded = computed(() => (levelProgress.value?.needed ? formatPlainNumber(levelProgress.value.needed) : '?'))
const expPercent = computed(() => {
  const p = levelProgress.value
  if (!p?.needed)
    return 0
  return Math.min(100, Math.max(0, (Number(p.current) / Number(p.needed)) * 100))
})

/** 本次运行时长（秒）。优先会话累计值，缺失时回落到进程 uptime。 */
const sessionSeconds = computed(() => Number(status.value?.sessionElapsedSeconds ?? status.value?.uptime) || 0)
const uptimeText = computed(() => {
  const total = Math.max(0, Math.floor(sessionSeconds.value))
  const pad = (n: number) => String(n).padStart(2, '0')
  const h = Math.floor(total / 3600)
  const m = Math.floor(total % 3600 / 60)
  const s = Math.floor(total % 60)
  return `${pad(h)}:${pad(m)}:${pad(s)}`
})

/** 本次经验/时：与 PC 版同一口径（本次获得的经验 ÷ 已运行小时）。 */
const expRate = computed(() => {
  const gain = Number(status.value?.sessionExpGained) || 0
  const hours = sessionSeconds.value / 3600
  if (!hours)
    return '0/时'
  return `${formatPlainNumber(Math.round(gain / hours))}/时`
})

/** 升级预测：与 LevelForecast 组件同一套判定，这里只要一句短文案。 */
const forecastText = computed(() => {
  const value = status.value?.levelForecast
  if (!isOnline.value)
    return ''
  if (!value || !value.estimatedAt)
    return value?.plotCount ? '本轮收获不足升级' : '等待预测数据'
  if (value.source === 'ready')
    return '收获后可升级'
  const minutes = Math.max(1, Math.ceil((value.estimatedAt - value.generatedAt) / 60000))
  const duration = minutes < 60 ? `${minutes} 分钟` : `${(minutes / 60).toFixed(1)} 小时`
  return value.source === 'planted' ? `预计 ${duration}后升级` : `预计 ${duration}后升级`
})

const quickLinks = [
  { key: 'activity', label: '活动中心', to: '/activity', icon: 'i-carbon-gift', bg: 'linear-gradient(135deg, #ffb020, #ff8a00)' },
  { key: 'mall', label: '游戏商城', to: '/game-mall', icon: 'i-carbon-shopping-bag', bg: 'linear-gradient(135deg, #4b9bff, #2f7ce0)' },
  { key: 'solar', label: '节令日历', to: '/activity?activity=solar', icon: 'i-carbon-calendar-heat-map', bg: 'linear-gradient(135deg, #ff6b5e, #e6432f)' },
  { key: 'automation', label: '自动化设置', to: '/settings?tab=account-config', icon: 'i-carbon-settings-adjust', bg: 'linear-gradient(135deg, #9b7bff, #6b4ce0)' },
] as const

const ASSET_FORMATTERS: Record<string, (value: unknown) => string> = {
  gold: formatCompactAsset,
  coupon: formatCompactAsset,
  goldBean: formatCompactAsset,
  diamond: formatAssetAmount,
}

const assetCards = computed(() => {
  const s = status.value?.status
  const deltaGold = Number(status.value?.runGoldGained) || 0
  const deltaCoupon = Number(status.value?.runCouponGained) || 0
  return [
    {
      key: 'gold',
      label: '金币',
      approx: true,
      icon: 'i-fas-coins',
      tint: 'color-mix(in srgb, #f5a623 16%, transparent)',
      color: '#e08a00',
      value: ASSET_FORMATTERS.gold(s?.gold),
      delta: deltaGold !== 0 ? `本次 ${deltaGold > 0 ? '+' : ''}${formatCompactAsset(deltaGold)}` : '',
    },
    {
      key: 'coupon',
      label: '点券',
      approx: true,
      icon: 'i-fas-ticket-alt',
      tint: 'color-mix(in srgb, #2fb36b 16%, transparent)',
      color: '#1f9d5c',
      value: ASSET_FORMATTERS.coupon(s?.coupon),
      delta: deltaCoupon !== 0 ? `本次 ${deltaCoupon > 0 ? '+' : ''}${formatCompactAsset(deltaCoupon)}` : '',
    },
    {
      key: 'goldBean',
      label: '金豆豆',
      approx: true,
      icon: 'i-fas-seedling',
      tint: 'color-mix(in srgb, #f0a020 16%, transparent)',
      color: '#d98900',
      value: ASSET_FORMATTERS.goldBean(s?.goldBean),
      delta: '',
    },
    {
      key: 'diamond',
      label: '钻石',
      approx: false,
      icon: 'i-fas-gem',
      tint: 'color-mix(in srgb, #35b8e8 16%, transparent)',
      color: '#1795c4',
      value: ASSET_FORMATTERS.diamond(diamondBalance.value),
      delta: '',
    },
  ]
})

const fertilizerNormal = computed(() => dashboardItems.value.find((item: any) => Number(item.id) === 1011))
const fertilizerOrganic = computed(() => dashboardItems.value.find((item: any) => Number(item.id) === 1012))

const fertilizerCards = computed(() => [
  {
    key: 'normal',
    label: '普通化肥',
    icon: 'i-fas-flask',
    tint: 'color-mix(in srgb, #4c9f70 16%, transparent)',
    color: '#2f8a5b',
    value: formatBucketTime(fertilizerNormal.value),
  },
  {
    key: 'organic',
    label: '有机化肥',
    icon: 'i-fas-vial',
    tint: 'color-mix(in srgb, #47b881 16%, transparent)',
    color: '#2f9d6a',
    value: formatBucketTime(fertilizerOrganic.value),
  },
])

function onAvatarError(event: Event) {
  failedAvatar.value = (event.currentTarget as HTMLImageElement | null)?.getAttribute('src') || ''
}

function formatPlainNumber(value: unknown) {
  const num = Number(value)
  return Number.isFinite(num) ? num.toLocaleString('zh-CN') : '0'
}

function formatAssetAmount(value: unknown) {
  const amount = Number(value)
  return Number.isFinite(amount) ? Math.max(0, Math.trunc(amount)).toLocaleString('zh-CN') : '0'
}

/** 大额资产紧凑显示（与 Dashboard 的 formatCompactAsset 同一规则）。 */
function formatCompactAsset(value: unknown) {
  const amount = Number(value)
  if (!Number.isFinite(amount))
    return '0'
  const n = Math.max(0, Math.trunc(amount))
  const unitValue = (divisor: number) => {
    const v = n / divisor
    return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')
  }
  if (n >= 1e8)
    return `${unitValue(1e8)}亿`
  if (n >= 1e4)
    return `${unitValue(1e4)}万`
  return n.toLocaleString('zh-CN')
}

/** 化肥容器：后端给的是秒数或已格式化的小时文案，统一显示成 「xx.xh」。 */
function formatBucketTime(item: any) {
  if (!item)
    return '0.0h'
  if (item.hoursText)
    return String(item.hoursText).replace('小时', 'h')
  const count = Number(item.count || 0)
  return `${(count / 3600).toFixed(1)}h`
}
</script>

<template>
  <div class="mob-overview">
    <!-- 账号：头像、等级、状态标签与升级进度 -->
    <section class="mob-card mob-account">
      <div class="mob-account__head">
        <div class="mob-avatar" :class="{ 'is-online': isOnline }">
          <img v-if="avatar && avatar !== failedAvatar" :key="avatar" :src="avatar" alt="" @error="onAvatarError">
          <span v-else class="i-carbon-user-avatar" aria-hidden="true" />
          <i class="mob-avatar__dot" />
        </div>
        <div class="mob-account__id">
          <div class="mob-account__name-row">
            <strong class="mob-account__name">{{ displayName }}</strong>
            <span class="mob-level">Lv.{{ level }}</span>
          </div>
          <div class="mob-chips">
            <span class="mob-chip" :class="isOnline ? 'is-online' : 'is-offline'">
              <i class="mob-chip__dot" />{{ isOnline ? '在线' : '离线' }}
            </span>
            <span v-if="platformLabel" class="mob-chip is-platform">{{ platformLabel }}</span>
            <span v-if="isOnline" class="mob-chip is-time">已运行 {{ uptimeText }}</span>
          </div>
        </div>
      </div>

      <div class="mob-exp">
        <div class="mob-exp__row">
          <span class="mob-exp__label">升级经验</span>
          <span class="mob-exp__value">{{ expCurrent }} / {{ expNeeded }} <b>({{ Math.floor(expPercent) }}%)</b></span>
        </div>
        <div class="mob-exp__track">
          <div class="mob-exp__bar" :style="{ width: `${expPercent}%` }" />
          <i class="mob-exp__knob" :style="{ left: `calc(${expPercent}% - 5px)` }" />
        </div>
      </div>

      <div class="mob-exp__foot">
        <span class="mob-exp__rate">经验速率 <b>{{ expRate }}</b></span>
        <span v-if="forecastText" class="mob-exp__forecast">{{ forecastText }}</span>
      </div>
    </section>

    <!-- 快捷入口 -->
    <nav class="mob-quick" aria-label="快捷入口">
      <RouterLink v-for="item in quickLinks" :key="item.key" :to="item.to" class="mob-quick__item">
        <span class="mob-quick__icon" :style="{ background: item.bg }"><span :class="item.icon" aria-hidden="true" /></span>
        <span class="mob-quick__label">{{ item.label }}</span>
      </RouterLink>
    </nav>

    <!-- 资产概览 -->
    <section class="mob-section">
      <h3 class="mob-section__title">
        资产概览
      </h3>
      <div class="mob-assets">
        <div v-for="item in assetCards" :key="item.key" class="mob-card mob-asset">
          <div class="mob-asset__label">
            <span class="mob-asset__icon" :style="{ background: item.tint, color: item.color }"><span :class="item.icon" aria-hidden="true" /></span>
            <span>{{ item.label }}</span>
            <small v-if="item.approx" class="mob-asset__approx">约</small>
          </div>
          <strong class="mob-asset__value">{{ item.value }}</strong>
          <small v-if="item.delta" class="mob-asset__delta">{{ item.delta }}</small>
        </div>
      </div>
    </section>

    <!-- 库存与化肥 -->
    <section class="mob-section">
      <div class="mob-section__head">
        <h3 class="mob-section__title">
          库存与化肥
        </h3>
        <RouterLink class="mob-section__link" to="/game-mall?tab=props">
          补充化肥 <span class="i-carbon-arrow-up-right" aria-hidden="true" />
        </RouterLink>
      </div>
      <div class="mob-assets">
        <div v-for="item in fertilizerCards" :key="item.key" class="mob-card mob-asset">
          <div class="mob-asset__label">
            <span class="mob-asset__icon" :style="{ background: item.tint, color: item.color }"><span :class="item.icon" aria-hidden="true" /></span>
            <span>{{ item.label }}</span>
          </div>
          <strong class="mob-asset__value">{{ item.value }}</strong>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.mob-overview {
  display: flex;
  flex-direction: column;
  gap: 14px;
  /* 左右留白由 .farm-page-content 提供（手机端 12px），这里只补底部呼吸。 */
  padding: 0 0 6px;
}

.mob-card {
  border-radius: 18px;
  background: var(--ui-surface);
  box-shadow: 0 1px 2px rgb(16 24 20 / 4%), 0 6px 18px rgb(16 24 20 / 4%);
}

/* ── 账号卡 ───────────────────────────────────────────── */
.mob-account {
  padding: 16px;
}

.mob-account__head {
  display: flex;
  align-items: center;
  gap: 12px;
}

.mob-avatar {
  position: relative;
  width: 56px;
  height: 56px;
  display: grid;
  flex: none;
  place-items: center;
  overflow: visible;
  border-radius: 999px;
  color: var(--ui-subtle);
  background: var(--ui-surface-soft);
  font-size: 28px;
}

.mob-avatar img {
  width: 100%;
  height: 100%;
  border-radius: inherit;
  object-fit: cover;
}

.mob-avatar__dot {
  position: absolute;
  right: 0;
  bottom: 2px;
  width: 14px;
  height: 14px;
  border: 3px solid var(--ui-surface);
  border-radius: 999px;
  background: var(--ui-subtle);
}

.mob-avatar.is-online .mob-avatar__dot {
  background: #22c55e;
}

.mob-account__id {
  min-width: 0;
  flex: 1;
}

.mob-account__name-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.mob-account__name {
  overflow: hidden;
  color: var(--ui-ink);
  font-size: 20px;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mob-level {
  flex: none;
  padding: 2px 8px;
  border-radius: 999px;
  color: var(--theme-primary);
  background: color-mix(in srgb, var(--theme-primary) 12%, transparent);
  font-size: 12px;
  font-weight: 600;
}

.mob-chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
}

.mob-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border-radius: 999px;
  background: var(--ui-surface-soft);
  color: var(--ui-muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  line-height: 1.4;
}

.mob-chip__dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--ui-subtle);
}

.mob-chip.is-online {
  color: #1f9d5c;
  background: color-mix(in srgb, #1f9d5c 12%, transparent);
}

.mob-chip.is-online .mob-chip__dot {
  background: #22c55e;
}

.mob-chip.is-offline {
  color: #d14343;
  background: color-mix(in srgb, #d14343 12%, transparent);
}

.mob-chip.is-platform {
  color: #1f9d5c;
  background: color-mix(in srgb, #1f9d5c 10%, transparent);
}

.mob-exp {
  margin-top: 14px;
}

.mob-exp__row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  color: var(--ui-muted);
  font-size: 12px;
}

.mob-exp__value {
  color: var(--ui-ink);
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}

.mob-exp__value b {
  margin-left: 2px;
  font-weight: 600;
}

.mob-exp__track {
  position: relative;
  height: 9px;
  margin-top: 8px;
  border-radius: 999px;
  background: var(--ui-surface-soft);
}

.mob-exp__bar {
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, #37b26f, var(--theme-primary));
  transition: width 0.4s ease;
}

.mob-exp__knob {
  position: absolute;
  top: 50%;
  width: 10px;
  height: 10px;
  border: 2px solid var(--ui-surface);
  border-radius: 999px;
  background: var(--theme-primary);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--theme-primary) 20%, transparent);
  transform: translateY(-50%);
}

.mob-exp__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 10px;
  color: var(--ui-subtle);
  font-size: 12px;
}

.mob-exp__rate b {
  color: var(--ui-muted);
  font-variant-numeric: tabular-nums;
}

.mob-exp__forecast {
  color: var(--theme-primary);
  font-weight: 600;
}

/* ── 快捷入口 ─────────────────────────────────────────── */
.mob-quick {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 4px;
  padding: 14px 8px;
  border-radius: 18px;
  background: var(--ui-surface);
  box-shadow: 0 1px 2px rgb(16 24 20 / 4%), 0 6px 18px rgb(16 24 20 / 4%);
}

.mob-quick__item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 4px;
  border-radius: 12px;
  text-decoration: none;
}

.mob-quick__item:active {
  background: var(--ui-surface-soft);
}

.mob-quick__icon {
  width: 46px;
  height: 46px;
  display: grid;
  place-items: center;
  border-radius: 14px;
  color: #fff;
  font-size: 24px;
  box-shadow: 0 4px 10px rgb(16 24 20 / 12%);
}

.mob-quick__label {
  color: var(--ui-muted);
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
}

/* ── 分区与资产卡 ─────────────────────────────────────── */
.mob-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.mob-section__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.mob-section__title {
  margin: 0;
  color: var(--ui-muted);
  font-size: 15px;
  font-weight: 600;
}

.mob-section__link {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  color: var(--theme-primary);
  font-size: 12px;
  font-weight: 600;
  text-decoration: none;
}

.mob-assets {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.mob-asset {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px;
}

.mob-asset__label {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--ui-muted);
  font-size: 12px;
  font-weight: 500;
}

.mob-asset__icon {
  width: 22px;
  height: 22px;
  display: grid;
  flex: none;
  place-items: center;
  border-radius: 7px;
  font-size: 12px;
}

.mob-asset__approx {
  color: var(--ui-subtle);
  font-size: 10px;
}

.mob-asset__value {
  color: var(--ui-ink);
  font-size: 28px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.02em;
  line-height: 1.15;
}

.mob-asset__delta {
  color: #1f9d5c;
  font-size: 11px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
</style>
