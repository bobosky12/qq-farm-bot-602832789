import api from '@/api'

/**
 * 在线更新与版本回滚的类型与接口封装。
 *
 * 单独成文件而不是塞进 `api/index.ts`：那块是全局 axios 实例与错误归一化，
 * 这里只描述这一个功能的契约，store 与组件都从这里取类型。
 */

export interface IncomingCommitInfo {
  hash: string
  shortHash: string
  subject: string
  author: string
  timestampMs: number
}

export interface PanelUpdateJobState {
  id: string
  action: 'update' | 'rollback' | 'snapshot'
  pid?: number
  status: 'running' | 'succeeded' | 'failed'
  phase: string
  detail?: string
  startedAt: number
  updatedAt: number
  finishedAt?: number
  exitCode?: number | null
  error?: string
  fromCommit?: string
  targetCommit?: string
  releaseId?: string
  recentLines: string[]
}

export interface ReleaseCompatInfo {
  compatible: boolean
  outdated: boolean
  reasons: string[]
}

export interface RollbackReleaseItem {
  releaseId: string
  kind: 'backend' | 'web'
  createdAt: number
  commit: string
  shortCommit: string
  commitSubject: string
  version: string
  build: number
  pairedReleaseId: string
  sizeBytes: number
  isActive: boolean
  isPrevious: boolean
  canRollback: boolean
  canDelete: boolean
  compat: ReleaseCompatInfo
}

export interface ReleasesSummary {
  totalCount: number
  rollbackableCount: number
  incompatibleCount: number
  totalSizeBytes: number
  incompatibleSizeBytes: number
  orphanWebCount: number
  orphanSizeBytes: number
  activeBackendId: string
  activeWebId: string
  activeVersion: string
  activeBuild: number
}

export interface SystemUpdateStatus {
  mode: 'source' | 'docker' | 'packaged' | 'unknown'
  gitSupported: boolean
  unsupportedReason: string
  applySupported: boolean
  applyUnsupportedReason: string
  repoRoot: string
  branch: string
  detached: boolean
  commit: string
  shortCommit: string
  commitSubject: string
  startupCommit: string
  needsApply: boolean
  upstream: string
  remote: string
  remoteBranch: string
  behindCount: number
  aheadCount: number
  dirtyFiles: string[]
  incomingCommits: IncomingCommitInfo[]
  canCheck: boolean
  canPull: boolean
  canApply: boolean
  jobBusy: boolean
  lastCheckedAt: number | null
  lastCheckError: string
  lastPulledAt: number | null
  job: PanelUpdateJobState | null
  releases: RollbackReleaseItem[]
  releasesSummary: ReleasesSummary | null
  webBuildId: string
  webVersion: string
}

export async function fetchSystemUpdateStatus(): Promise<SystemUpdateStatus> {
  const res = await api.get('/api/system-update/status')
  return res.data?.data
}

export async function fetchSystemUpdateJob(): Promise<{ job: PanelUpdateJobState | null, log: string }> {
  const res = await api.get('/api/system-update/job')
  return res.data?.data || { job: null, log: '' }
}
