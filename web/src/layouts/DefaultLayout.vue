<script setup lang="ts">
import { useMediaQuery } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { computed, nextTick, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Sidebar from '@/components/Sidebar.vue'
import TopAccountMenu from '@/components/TopAccountMenu.vue'
import { useAccountSwitchScrollPreserve } from '@/composables/useAccountSwitchScroll'
import { isMenuActive, matchMenu, menuGroups, menuLink, visibleMenuRoutes } from '@/router/menu'
import { isRanchMenuActive, matchRanchMenu, ranchMenu } from '@/router/ranch-menu'
import { useAppStore } from '@/stores/app'
import { useSceneStore } from '@/stores/scene'
import { useToastStore } from '@/stores/toast'
import { useUserStore } from '@/stores/user'

const appStore = useAppStore()
const sceneStore = useSceneStore()
const userStore = useUserStore()
const route = useRoute()
const router = useRouter()
// 布局级常驻：切换账号后保持当前页面与滚动位置，所有页面统一生效
useAccountSwitchScrollPreserve()
const { sidebarOpen, activityDetailOpen } = storeToRefs(appStore)
const desktop = useMediaQuery('(min-width: 1024px)')
const loggingOut = ref(false)
let drawerTrigger: HTMLElement | null = null

const currentMenu = computed(() => (sceneStore.scene === 'ranch' ? matchRanchMenu(route.path) : matchMenu(route.path)))
const currentGroup = computed(() => {
  if (sceneStore.scene === 'ranch')
    return '我的牧场'
  const item = currentMenu.value
  const group = item && 'group' in item ? item.group : undefined
  return menuGroups.find(entry => entry.key === group)?.label || '我的庄园'
})
const currentLabel = computed(() => {
  const item = currentMenu.value
  if (!item)
    return '农场'
  return ('navLabel' in item && item.navLabel) || item.label
})
/** 手机底部导航同样跟着场景换：牧场只出牧场入口，不把农场页面混进来。 */
const mobileItems = computed(() => {
  if (sceneStore.scene === 'ranch') {
    return ranchMenu.filter(item => item.mobileLabel).map(item => ({
      key: item.name,
      to: item.path,
      label: item.mobileLabel || item.label,
      icon: item.icon,
      active: isRanchMenuActive(item, route.path),
    }))
  }
  // 农场底部导航按手机端习惯排序：总览 / 农场 / 发现 / 好友 / 我的。
  const MOBILE_ORDER = ['dashboard', 'personal', 'activity-center', 'friends', 'Settings']
  return visibleMenuRoutes()
    .filter(item => item.mobileLabel)
    .sort((a, b) => MOBILE_ORDER.indexOf(a.name) - MOBILE_ORDER.indexOf(b.name))
    .map(item => ({
      key: item.name,
      to: menuLink(item),
      label: item.mobileLabel || item.label,
      icon: item.icon,
      active: isMenuActive(item, route.path),
    }))
})
const moreActive = computed(() => !mobileItems.value.some(item => item.active))
void moreActive.value

// 手机顶部：农场/牧场分段切换（与侧栏同一份 sceneStore，切场景即换整套页面）。
const SCENE_OPTIONS: Array<{ key: 'farm' | 'ranch', label: string, icon: string }> = [
  { key: 'farm', label: '农场', icon: 'i-carbon-sprout' },
  { key: 'ranch', label: '牧场', icon: 'i-carbon-wheat' },
]

function switchScene(key: 'farm' | 'ranch') {
  if (sceneStore.scene === key)
    return
  sceneStore.select(key)
  router.push(key === 'ranch' ? '/ranch' : '/')
}
// 路由是场景的真值来源：直接点菜单进「牧场」也要把开关切过去，
// 否则会出现「页面已经在牧场、侧栏还写着农场」的矛盾状态。
// 设置页两个场景共用，停在设置页时保持进来时的场景，不强行切回农场。
watch(() => route.path, (path) => {
  if (path === '/settings')
    return
  sceneStore.setScene(path.startsWith('/ranch') ? 'ranch' : 'farm')
}, { immediate: true })
// 活动详情自带标题栏并要求撑满内容区，这时把滚动交给活动自己的外壳。
const activityDetail = computed(() => route.name === 'activity-center' && activityDetailOpen.value)

watch(sidebarOpen, async (open) => {
  if (open && !desktop.value) {
    drawerTrigger = document.activeElement as HTMLElement | null
  }
  else if (!open && !desktop.value) {
    await nextTick()
    drawerTrigger?.focus()
  }
})

async function logout() {
  if (loggingOut.value)
    return
  loggingOut.value = true
  try {
    await userStore.logout()
    await router.push('/login')
  }
  catch {
    useToastStore().error('退出失败，请重试')
  }
  finally {
    loggingOut.value = false
  }
}
</script>

<template>
  <div class="farm-shell">
    <a href="#farm-page-content" class="farm-skip-link">跳到页面内容</a>
    <button v-if="sidebarOpen && !desktop" type="button" class="farm-drawer-overlay" tabindex="-1" aria-label="关闭导航" @click="appStore.closeSidebar" />
    <Sidebar />
    <div class="farm-workspace" :inert="sidebarOpen && !desktop">
      <header class="farm-topbar">
        <!-- 手机端：农场/牧场分段 + 账号胶囊（复刻 App 顶栏） -->
        <div class="farm-topbar-mobile lg:hidden">
          <button type="button" aria-label="打开导航" :aria-expanded="sidebarOpen" aria-controls="farm-sidebar" class="farm-icon-button farm-topbar-mobile__menu" @click="appStore.openSidebar">
            <span class="i-carbon-menu" aria-hidden="true" />
          </button>
          <div class="mob-scene-switch" role="group" aria-label="农牧场切换">
            <button
              v-for="option in SCENE_OPTIONS"
              :key="option.key"
              type="button"
              class="mob-scene-option"
              :class="{ 'is-active': sceneStore.scene === option.key }"
              :aria-pressed="sceneStore.scene === option.key"
              @click="switchScene(option.key)"
            >
              <span :class="option.icon" aria-hidden="true" />
              <span>{{ option.label }}</span>
            </button>
          </div>
          <div class="mob-account">
            <TopAccountMenu />
          </div>
        </div>

        <!-- 桌面端：面包屑 + 账号菜单 + 退出验证 -->
        <div class="farm-topbar-desktop hidden w-full items-center justify-between gap-3 lg:flex">
          <div class="farm-breadcrumb">
            <span>{{ currentGroup }}</span><span class="opacity-40" aria-hidden="true">/</span>
            <strong>{{ currentLabel }}</strong>
          </div>
          <div class="farm-topbar-actions">
            <TopAccountMenu />
            <button class="farm-icon-button" type="button" title="退出验证" aria-label="退出验证" :disabled="loggingOut" @click="logout">
              <span :class="loggingOut ? 'i-svg-spinners-ring-resize' : 'i-carbon-logout'" aria-hidden="true" />
            </button>
          </div>
        </div>
      </header>
      <main id="farm-page-content" class="farm-page-content" :class="{ 'is-activity-detail': activityDetail }" tabindex="-1">
        <RouterView v-slot="{ Component, route: pageRoute }">
          <component :is="Component" :key="pageRoute.path" class="farm-page" />
        </RouterView>
      </main>
      <nav class="farm-mobile-nav" aria-label="快捷导航">
        <RouterLink v-for="item in mobileItems" :key="item.key" :to="item.to" :class="{ 'is-active': item.active }" :aria-current="item.active ? 'page' : undefined">
          <span :class="item.icon" aria-hidden="true" /><span>{{ item.label }}</span>
        </RouterLink>
      </nav>
    </div>
  </div>
</template>

<style scoped>
.farm-shell {
  display: flex;
  width: 100%;
  height: 100dvh;
  overflow: hidden;
}
.farm-workspace {
  display: flex;
  flex: 1;
  min-width: 0;
  height: 100%;
  flex-direction: column;
}
.farm-topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 76px;
  padding: 12px 30px;
  flex-shrink: 0;
  border-bottom: 1px solid var(--surface-border);
  background: var(--farm-header);
  position: relative;
  z-index: 30;
}
.farm-breadcrumb {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  font-size: 12px;
  color: var(--muted-text);
}
.farm-breadcrumb strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--theme-text);
  font-size: 14px;
  font-weight: 650;
}
.farm-topbar-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.farm-icon-button {
  display: inline-grid;
  width: 38px;
  height: 38px;
  flex: none;
  place-items: center;
  border: 1px solid var(--surface-border);
  border-radius: 10px;
  color: var(--muted-text);
  background: var(--surface-1);
  font-size: 19px;
  transition:
    color 150ms,
    border-color 150ms;
}
.farm-icon-button:hover {
  border-color: var(--surface-border-strong);
  color: var(--theme-primary);
}
.farm-icon-button:disabled {
  opacity: 0.55;
}
.farm-page-content {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 24px 30px 30px;
  scroll-padding-top: 16px;
  -webkit-overflow-scrolling: touch;
  overscroll-behavior: contain;
}
.farm-page-content:focus {
  outline: none;
}
.farm-page-content.is-activity-detail {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding-bottom: 16px;
}
.farm-page-content.is-activity-detail > :deep(*) {
  flex: 1;
  min-height: 0;
}
.farm-mobile-nav {
  display: none;
}
.farm-drawer-overlay {
  position: fixed;
  inset: 0;
  z-index: 40;
  background: rgb(14 29 20 / 48%);
}
.farm-skip-link {
  position: fixed;
  top: -100px;
  left: 16px;
  z-index: 80;
  padding: 12px 18px;
  border-radius: 10px;
  background: var(--surface-1);
  color: var(--theme-primary);
}
.farm-skip-link:focus {
  top: 10px;
}
@media (min-width: 1800px) {
  .farm-page-content {
    padding-inline: max(30px, calc((100vw - 1850px) / 2));
  }
}
@media (max-width: 1023px) {
  .farm-topbar {
    min-height: 60px;
    padding: 8px 10px;
    gap: 4px;
  }
  /* 手机顶栏：菜单 + 农场/牧场分段 + 账号胶囊（复刻 App） */
  .farm-topbar-mobile {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
  }
  .farm-topbar-mobile__menu {
    flex: none;
  }
  .mob-scene-switch {
    display: inline-flex;
    flex: none;
    gap: 2px;
    padding: 3px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--ui-ink) 7%, transparent);
  }
  .mob-scene-option {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 7px 13px;
    border: none;
    border-radius: 999px;
    background: transparent;
    color: var(--ui-muted);
    font-size: 13px;
    font-weight: 600;
    line-height: 1;
    white-space: nowrap;
  }
  .mob-scene-option > span:first-child {
    font-size: 16px;
  }
  .mob-scene-option.is-active {
    background: var(--theme-primary);
    color: #fff;
    box-shadow: 0 2px 6px color-mix(in srgb, var(--theme-primary) 35%, transparent);
  }
  .mob-account {
    min-width: 0;
    margin-left: auto;
  }
  /* 账号胶囊：只要头像 + 名字，副标题隐藏（更贴近 App 顶栏） */
  .mob-account :deep(.top-account-trigger) {
    gap: 6px;
    padding: 4px 10px 4px 4px;
    border-radius: 999px;
    background: var(--ui-surface);
    box-shadow: 0 1px 2px rgb(16 24 20 / 6%);
  }
  .mob-account :deep(.top-account-trigger > span:first-child) {
    width: 28px;
    height: 28px;
  }
  .mob-account :deep(.top-account-subtitle) {
    display: none;
  }
  .mob-account :deep(.top-account-trigger .text-sm) {
    font-size: 13px;
  }
  .farm-page-content {
    padding: 12px 12px 18px;
  }
  /* 底部导航：浮起圆角条，当前项浅绿胶囊（复刻 App） */
  .farm-mobile-nav {
    display: flex;
    flex-shrink: 0;
    justify-content: space-around;
    gap: 2px;
    margin: 0 10px calc(10px + env(safe-area-inset-bottom));
    padding: 7px 6px;
    border-top: none;
    border-radius: 22px;
    background: var(--ui-surface);
    box-shadow: 0 8px 24px rgb(16 24 20 / 12%);
  }
  .farm-mobile-nav a {
    display: flex;
    flex: 1;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 4px;
    min-width: 0;
    min-height: 46px;
    padding: 4px 2px;
    border-radius: 16px;
    font-size: 11px;
    color: var(--ui-subtle);
    text-decoration: none;
    transition:
      background 0.2s ease,
      color 0.2s ease;
  }
  .farm-mobile-nav a > span:first-child {
    font-size: 22px;
  }
  .farm-mobile-nav .is-active {
    color: var(--theme-primary);
    background: color-mix(in srgb, var(--theme-primary) 13%, transparent);
    font-weight: 650;
  }
}
@media (max-width: 639px) {
  .farm-topbar {
    padding-inline: 10px;
  }
  .farm-topbar-actions {
    gap: 2px;
  }
  .farm-topbar-actions .farm-icon-button {
    width: 34px;
    height: 34px;
    font-size: 17px;
  }
  .farm-breadcrumb strong {
    max-width: 84px;
    font-size: 13px;
  }
  .farm-page-content {
    padding: 14px 12px 20px;
  }
}
</style>
