<script setup lang="ts">
import type { RollbackReleaseItem } from '@/api/system-update'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import ConfirmModal from '@/components/ConfirmModal.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import { useAppUpdateStore } from '@/stores/app-update'

/**
 * 版本与更新。
 *
 * 整个流程最反直觉的一点：点「立即更新」之后，服务会自己把自己杀掉重启，
 * 中途所有请求都会失败几秒到几分钟。所以这里的进度区**不显示错误**，只显示
 * 「等待服务回来」，直到后端重新可读作业状态为止。
 */

const store = useAppUpdateStore()

const confirmVisible = ref(false)
const confirmTitle = ref('')
const confirmMessage = ref('')
const confirmType = ref<'danger' | 'primary'>('primary')
const confirmAction = ref<(() => void) | null>(null)
const logExpanded = ref(false)

function formatBytes(bytes: number): string {
  const value = Number(bytes) || 0
  if (value <= 0)
    return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)))
  return `${(value / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}

function formatTime(ms: number): string {
  if (!ms)
    return '—'
  const date = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function formatDuration(from: number, to: number): string {
  if (!from)
    return ''
  const seconds = Math.max(0, Math.round(((to || Date.now()) - from) / 1000))
  if (seconds < 60)
    return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  return `${minutes} 分 ${seconds % 60} 秒`
}

const modeLabel = computed(() => {
  const mode = store.status?.mode
  if (mode === 'source')
    return '源码部署'
  if (mode === 'docker')
    return 'Docker 容器'
  if (mode === 'packaged')
    return '打包版'
  return '未知'
})

const inProgress = computed(() => store.jobRunning || store.reconnecting)
const activeJob = computed(() => store.job)

const applyHint = computed(() => {
  const status = store.status
  if (!status)
    return '正在读取状态…'
  if (!status.applySupported)
    return status.applyUnsupportedReason || '当前运行方式不支持面板一键更新'
  if (status.jobBusy)
    return '已有任务在运行'
  if (store.dirtyCount > 0)
    return `工作区有 ${store.dirtyCount} 个未提交改动，请先提交或还原`
  if (status.behindCount === 0 && !status.needsApply)
    return status.lastCheckedAt == null ? '还没有检查过远端，点「立即更新」会自动先检查' : '已经是最新版本'
  if (status.behindCount > 0)
    return `有 ${status.behindCount} 个新提交可以拉取`
  return '代码已更新，需要重启生效'
})

function askConfirm(title: string, message: string, type: 'danger' | 'primary', action: () => void) {
  confirmTitle.value = title
  confirmMessage.value = message
  confirmType.value = type
  confirmAction.value = action
  confirmVisible.value = true
}

function handleConfirm() {
  confirmVisible.value = false
  const action = confirmAction.value
  confirmAction.value = null
  action?.()
}

function handleCancel() {
  confirmVisible.value = false
  confirmAction.value = null
}

async function handleCheck() {
  await store.check()
}

function handleApply() {
  const status = store.status
  if (!status)
    return
  const detail = status.behindCount > 0
    ? `将拉取 ${status.behindCount} 个新提交，然后重新构建并重启服务。更新期间面板会短暂断连，属于正常现象。`
    : '代码已经是最新，将重新构建并重启服务让改动生效。更新期间面板会短暂断连，属于正常现象。'
  askConfirm('立即更新', detail, 'primary', () => {
    void store.applyUpdate()
  })
}

function handleRollback(item: RollbackReleaseItem) {
  const warnings: string[] = []
  warnings.push(`将把源码切换到 ${item.shortCommit}（${item.version || '未知版本'}），并把归档的构建产物覆盖回去，随后重启服务。`)
  // 不兼容只提示不禁止：游戏客户端小版本变动通常不影响旧构建，一刀切禁掉会把用户
  // 卡在「新版有 BUG、旧版不给回」的死角。风险讲清楚，让用户自己确认。
  const confirmIncompatible = !item.compat.compatible
  if (confirmIncompatible && item.compat.reasons.length)
    warnings.push(`注意：该版本与当前客户端版本不一致（${item.compat.reasons.join('；')}），可能导致登录失败。`)
  warnings.push('回滚会丢弃当前分支上尚未推送的本地提交，请确认已经推送。')
  askConfirm('回滚到此版本', warnings.join('\n'), 'danger', () => {
    void store.rollback(item.releaseId, confirmIncompatible)
  })
}

function handleDelete(item: RollbackReleaseItem) {
  askConfirm('删除该版本', `将删除 ${item.releaseId}，释放 ${formatBytes(item.sizeBytes)}。删除后无法再回滚到这个版本。`, 'danger', () => {
    void store.removeReleases([item.releaseId])
  })
}

function handleCleanOrphans() {
  askConfirm('清理孤儿版本', '将删除所有找不到对应后端版本的前端归档。这些归档已经无法被任何回滚使用。', 'danger', () => {
    void store.cleanOrphans()
  })
}

onMounted(async () => {
  await store.refreshStatus()
  // 上一次的作业还在跑（比如刷新页面之后）就接着轮询，别让用户以为卡住了。
  if (store.job?.status === 'running')
    store.pollJob()
})

onUnmounted(() => {
  store.stopPolling()
})
</script>

<template>
  <div class="space-y-4">
    <h3 class="text-lg text-gray-900 font-bold dark:text-gray-100">
      版本与更新
    </h3>
    <p class="text-xs text-gray-500 -mt-2 dark:text-gray-400">
      从远端仓库拉取新代码、重新构建并重启，或者回退到任意一次历史构建
    </p>

    <!-- 当前运行状态 -->
    <section class="farm-card rounded-lg p-4">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0">
          <div class="text-xs text-gray-500 dark:text-gray-400">
            当前运行版本
          </div>
          <div class="mt-1 text-xl text-gray-900 font-bold dark:text-gray-100">
            {{ store.summary?.activeVersion ? `v${store.summary.activeVersion}` : '未知' }}
            <span v-if="store.summary?.activeBuild" class="ml-1 text-xs text-gray-500 font-normal dark:text-gray-400">第 {{ store.summary.activeBuild }} 次更新</span>
          </div>
          <div class="mt-1 break-all text-xs text-gray-500 dark:text-gray-400">
            <span>{{ modeLabel }}</span>
            <span v-if="store.status?.branch"> · 分支 {{ store.status.branch }}</span>
            <span v-if="store.status?.shortCommit"> · 提交 {{ store.status.shortCommit }}</span>
          </div>
          <div v-if="store.status?.commitSubject" class="mt-0.5 truncate text-xs text-gray-500 dark:text-gray-400" :title="store.status.commitSubject">
            {{ store.status.commitSubject }}
          </div>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <BaseButton variant="outline" size="sm" :loading="store.loading" :disabled="inProgress" @click="handleCheck">
            检查更新
          </BaseButton>
          <BaseButton variant="primary" size="sm" :loading="store.acting" :disabled="!store.canApply || inProgress" :title="applyHint" @click="handleApply">
            立即更新
          </BaseButton>
        </div>
      </div>

      <div class="mt-3 border-t pt-3 text-xs dark:border-gray-700">
        <span :class="store.canApply ? 'text-emerald-600 dark:text-emerald-400' : 'text-gray-500 dark:text-gray-400'">
          {{ applyHint }}
        </span>
        <span v-if="store.status?.dirtyFiles?.length" class="ml-2 text-amber-600 dark:text-amber-400">
          （{{ store.status.dirtyFiles.slice(0, 3).join('、') }}{{ store.status.dirtyFiles.length > 3 ? ' 等' : '' }}）
        </span>
      </div>

      <div v-if="store.status?.lastCheckError" class="mt-2 rounded bg-amber-50 px-2 py-1 text-xs text-amber-700 dark:bg-amber-900/20 dark:text-amber-300">
        {{ store.status.lastCheckError }}
      </div>
    </section>

    <!-- 待更新的提交 -->
    <section v-if="store.hasIncoming" class="farm-card rounded-lg p-4">
      <div class="mb-2 flex items-center justify-between">
        <h4 class="text-base text-gray-900 font-bold dark:text-gray-100">
          待更新的提交
        </h4>
        <span class="text-xs text-gray-500 dark:text-gray-400">{{ store.status?.behindCount }} 个</span>
      </div>
      <ul class="space-y-1.5">
        <li v-for="commit in store.status?.incomingCommits || []" :key="commit.hash" class="flex items-start gap-2 text-xs">
          <code class="shrink-0 rounded bg-gray-100 px-1 text-gray-600 font-mono dark:bg-gray-800 dark:text-gray-300">{{ commit.shortHash }}</code>
          <span class="min-w-0 flex-1 break-words text-gray-700 dark:text-gray-300">{{ commit.subject }}</span>
          <span class="shrink-0 text-gray-400 dark:text-gray-500">{{ commit.author }}</span>
        </li>
      </ul>
    </section>

    <!-- 作业进度 -->
    <section v-if="activeJob" class="farm-card rounded-lg p-4">
      <div class="mb-2 flex items-start justify-between gap-2">
        <div class="min-w-0">
          <h4 class="text-base text-gray-900 font-bold dark:text-gray-100">
            {{ activeJob.action === 'rollback' ? '回滚进度' : '更新进度' }}
          </h4>
          <div class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
            {{ activeJob.phase }}<span v-if="activeJob.detail"> — {{ activeJob.detail }}</span>
          </div>
        </div>
        <div class="shrink-0 text-right text-xs text-gray-500 dark:text-gray-400">
          <div v-if="activeJob.status === 'running'" class="text-sky-600 dark:text-sky-400">
            进行中 · {{ formatDuration(activeJob.startedAt, Date.now()) }}
          </div>
          <div v-else-if="activeJob.status === 'succeeded'" class="text-emerald-600 dark:text-emerald-400">
            已完成
          </div>
          <div v-else class="text-red-600 dark:text-red-400">
            失败
          </div>
          <div v-if="activeJob.fromCommit || activeJob.targetCommit" class="mt-0.5 font-mono">
            {{ activeJob.fromCommit || '?' }} → {{ activeJob.targetCommit || '?' }}
          </div>
        </div>
      </div>

      <div v-if="store.reconnecting" class="mb-2 rounded bg-sky-50 px-2 py-1 text-xs text-sky-700 dark:bg-sky-900/20 dark:text-sky-300">
        服务正在重启，连接断开是正常现象，正在等待它回来…
      </div>

      <div v-if="activeJob.error" class="mb-2 whitespace-pre-wrap rounded bg-red-50 px-2 py-1 text-xs text-red-700 dark:bg-red-900/20 dark:text-red-300">
        {{ activeJob.error }}
      </div>

      <div class="rounded bg-gray-900 p-2 text-xs text-gray-100 font-mono">
        <div class="max-h-48 overflow-y-auto">
          <div v-for="(line, index) in activeJob.recentLines.slice(logExpanded ? -200 : -12)" :key="index" class="whitespace-pre-wrap break-all leading-5">
            {{ line }}
          </div>
        </div>
      </div>

      <div class="mt-2 flex items-center justify-between">
        <button class="text-xs text-sky-600 dark:text-sky-400 hover:underline" @click="logExpanded = !logExpanded">
          {{ logExpanded ? '收起日志' : '展开完整日志' }}
        </button>
        <div class="flex items-center gap-2">
          <BaseButton v-if="activeJob.status !== 'running'" variant="ghost" size="sm" @click="store.dismissJob()">
            关闭
          </BaseButton>
          <BaseButton v-if="store.stalePanel" variant="primary" size="sm" @click="store.reloadPanel()">
            面板已更新，点此刷新
          </BaseButton>
        </div>
      </div>
    </section>

    <!-- 面板过期提醒（没有作业时也要提示） -->
    <section v-else-if="store.stalePanel" class="farm-card rounded-lg p-4">
      <div class="flex items-center justify-between gap-3">
        <div class="text-sm text-gray-700 dark:text-gray-300">
          服务器上运行的前端已经是新版本，当前页面还是旧代码
        </div>
        <BaseButton variant="primary" size="sm" @click="store.reloadPanel()">
          刷新页面
        </BaseButton>
      </div>
    </section>

    <!-- 历史版本 -->
    <section class="farm-card rounded-lg p-4">
      <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 class="text-base text-gray-900 font-bold dark:text-gray-100">
            历史版本
          </h4>
          <p class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
            每次更新前会自动归档当时的构建产物，回滚直接用归档，不需要重新构建
          </p>
        </div>
        <div class="flex items-center gap-2">
          <span class="text-xs text-gray-500 dark:text-gray-400">
            {{ store.summary?.totalCount || 0 }} 个 · 占用 {{ formatBytes(store.summary?.totalSizeBytes || 0) }}
          </span>
          <BaseButton
            v-if="store.summary?.orphanWebCount"
            variant="outline"
            size="sm"
            :loading="store.acting"
            @click="handleCleanOrphans"
          >
            清理孤儿（{{ store.summary.orphanWebCount }}）
          </BaseButton>
        </div>
      </div>

      <div v-if="!store.releases.length" class="rounded bg-gray-50 px-3 py-6 text-center text-xs text-gray-500 dark:bg-gray-900/30 dark:text-gray-400">
        还没有历史版本。执行一次更新后，更新前的版本会自动归档到这里。
      </div>

      <ul v-else class="space-y-2">
        <li
          v-for="item in store.releases"
          :key="item.releaseId"
          class="flex flex-wrap items-center justify-between gap-2 border rounded-lg px-3 py-2 dark:border-gray-700"
          :class="item.isActive ? 'border-emerald-300 bg-emerald-50/60 dark:border-emerald-800 dark:bg-emerald-900/10' : 'border-gray-200 bg-gray-50/70 dark:bg-gray-900/30'"
        >
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-1.5">
              <span class="text-sm text-gray-900 font-medium dark:text-gray-100">
                {{ item.version ? `v${item.version}` : '未知版本' }}
              </span>
              <span class="rounded bg-gray-200 px-1 text-[10px] text-gray-600 dark:bg-gray-700 dark:text-gray-300">{{ item.kind === 'backend' ? '后端' : '前端' }}</span>
              <span v-if="item.isActive" class="rounded bg-emerald-100 px-1 text-[10px] text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">运行中</span>
              <span v-else-if="item.isPrevious" class="rounded bg-sky-100 px-1 text-[10px] text-sky-700 dark:bg-sky-900/40 dark:text-sky-300">上一版</span>
              <span v-if="!item.compat.compatible" class="rounded bg-amber-100 px-1 text-[10px] text-amber-700 dark:bg-amber-900/40 dark:text-amber-300" :title="item.compat.reasons.join('；')">版本不匹配</span>
            </div>
            <div class="mt-0.5 break-all text-xs text-gray-500 dark:text-gray-400">
              {{ formatTime(item.createdAt) }} · <code class="font-mono">{{ item.shortCommit }}</code>
              <span v-if="item.commitSubject"> · {{ item.commitSubject }}</span>
            </div>
          </div>
          <div class="flex shrink-0 items-center gap-1.5">
            <span class="text-[11px] text-gray-400 dark:text-gray-500">{{ formatBytes(item.sizeBytes) }}</span>
            <BaseButton
              v-if="item.kind === 'backend'"
              variant="outline"
              size="sm"
              :disabled="!item.canRollback || inProgress"
              :title="item.canRollback ? '' : '当前运行版本或归档不完整'"
              @click="handleRollback(item)"
            >
              回滚
            </BaseButton>
            <BaseButton
              variant="ghost"
              size="sm"
              :disabled="!item.canDelete || inProgress"
              :title="item.canDelete ? '' : '运行中/上一版不能删除'"
              @click="handleDelete(item)"
            >
              删除
            </BaseButton>
          </div>
        </li>
      </ul>
    </section>

    <ConfirmModal
      :show="confirmVisible"
      :title="confirmTitle"
      :message="confirmMessage"
      :type="confirmType"
      confirm-text="确认"
      cancel-text="取消"
      @confirm="handleConfirm"
      @cancel="handleCancel"
    />
  </div>
</template>
