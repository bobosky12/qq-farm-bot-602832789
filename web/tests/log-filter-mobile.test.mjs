import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import test from 'node:test'

const read = relative => readFileSync(new URL(relative, import.meta.url), 'utf8')
const dashboard = read('../src/views/Dashboard.vue')
const panel = read('../src/components/RunLogPanel.vue')
const card = read('../src/components/RunLogCard.vue')
const overview = read('../src/views/RanchOverview.vue')
const constants = read('../src/constants/log-filters.ts')
const statusStore = read('../src/stores/status.ts')

/** 取某个样式规则块（到第一个右花括号为止）。 */
function rule(source, selector) {
  const start = source.indexOf(`${selector} {`)
  assert.notEqual(start, -1, `样式块 ${selector} 不存在`)
  return source.slice(start, source.indexOf('}', start))
}

/** 取指定 at-rule 的完整内容，用花括号配对避免被内层规则截断。 */
function atRule(source, query) {
  const start = source.lastIndexOf(query)
  assert.notEqual(start, -1, `规则 ${query} 不存在`)
  const open = source.indexOf('{', start)
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{')
      depth++
    else if (source[i] === '}' && --depth === 0)
      return source.slice(open + 1, i)
  }
  assert.fail(`规则 ${query} 未闭合`)
}

// 日志视图统一到 RunLogPanel（上游 #184）：农场概览与牧场面板共用一套，
// 各自只通过 default-module 指定默认筛选，避免两处逻辑再次分叉。

test('农场概览：日志区交给 RunLogPanel，默认筛选农场', () => {
  assert.match(dashboard, /<RunLogPanel default-module="farm"/)
  assert.match(dashboard, /import RunLogPanel from '@\/components\/RunLogPanel\.vue'/)
})

test('农场概览：旧内联日志实现已彻底移除，不留半套逻辑', () => {
  for (const symbol of ['displayLogs', 'filteredLogs', 'visibleLogs', 'formatLogTimeRange', 'getEventLabel', 'const logLevels = [', 'class="log-filters"']) {
    assert.ok(!dashboard.includes(symbol), `Dashboard 仍残留旧日志实现：${symbol}`)
  }
  // 日志拉取也归组件：页面里不该再出现 fetchLogs
  assert.ok(!dashboard.includes('fetchLogs'), 'Dashboard 不应再自己拉日志')
})

test('牧场面板：RunLogCard 只是 RunLogPanel 的牧场壳', () => {
  assert.match(overview, /<RunLogCard \/>/)
  assert.match(card, /import RunLogPanel from '@\/components\/RunLogPanel\.vue'/)
  assert.match(card, /default-module="ranch"/)
  // 壳里不该再有自己的筛选/聚合实现
  assert.ok(!card.includes('computed('), 'RunLogCard 应保持为纯包装')
})

test('统一日志组件：一级/二级模块 + 事件 + 级别 + 关键词 + 搜索清空齐全', () => {
  assert.match(panel, /v-model="filter\.module"[\s\S]{0,60}:options="modules"/)
  assert.match(panel, /v-model="filter\.submodule"[\s\S]{0,60}:options="submoduleOptions"/)
  assert.match(panel, /v-model="filter\.event"[\s\S]{0,60}:options="events"/)
  assert.match(panel, /v-model="filter\.level"[\s\S]{0,60}:options="levels"/)
  assert.match(panel, /v-model="filter\.keyword"/)
  assert.match(panel, /title="搜索日志"/)
  assert.match(panel, /title="清空日志"/)
  // 当前筛选条件以胶囊形式展示，可单条移除
  assert.match(panel, /activeFilterChips/)
  assert.match(panel, /function removeFilter/)
})

test('统一日志组件：×N 可展开明细，且提供回到最新按钮', () => {
  assert.match(panel, /class="log-row__repeat"/)
  assert.match(panel, /@click="toggleGroup\(group\.uid\)"/)
  assert.match(panel, /run-log-expanded/)
  assert.match(panel, /run-log-to-latest/)
})

test('筛选区窄屏两列、宽屏五列 + 按钮列', () => {
  const filters = rule(panel, '.run-log-filters')
  assert.match(filters, /grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/, '窄屏两列')

  const wide = atRule(panel, '@media (min-width: 640px)')
  assert.match(wide, /grid-template-columns:\s*repeat\(5, minmax\(0, 8rem\)\) auto/, '宽屏五列筛选 + 按钮')
  assert.match(wide, /\.run-log-filters__buttons[\s\S]*?grid-column:\s*auto/)

  const buttons = rule(panel, '.run-log-filters__buttons')
  assert.match(buttons, /grid-column:\s*1 \/ -1/, '窄屏按钮独占一行')
})

test('日志行窄屏折成两列，正文整行铺满', () => {
  const row = rule(panel, '.log-row')
  assert.match(row, /grid-template-columns:\s*auto auto minmax\(0, 1fr\)/)

  const phone = atRule(panel, '@media (max-width: 640px)')
  assert.match(phone, /\.log-row[\s\S]*?grid-template-columns:\s*auto minmax\(0, 1fr\)/)
  assert.match(phone, /\.log-row__body[\s\S]*?grid-column:\s*1 \/ -1/)
})

test('模块常量：好友/仓库降为农场子模块，一级模块不再单列', () => {
  assert.match(constants, /export const LOG_MODULES/)
  assert.ok(!/label: '好友'/.test(constants.slice(constants.indexOf('LOG_MODULES'), constants.indexOf('SUBMODULES_BY_PARENT'))), '好友应作为子模块')
  assert.match(constants, /farm:\s*\[[\s\S]*?value: 'friend'[\s\S]*?value: 'warehouse'/)
  assert.match(constants, /ranch:\s*\[[\s\S]*?value: 'friend'/)
  // 农场一级模块要一次把降级的 friend/warehouse 都拉回来，否则子模块筛选拿不到数据
  assert.match(constants, /farm:\s*'farm,friend,warehouse'/)
})

test('缓存冗余 500 行，聚合后再截断', () => {
  assert.match(constants, /export const LOG_CACHE_LIMIT = 500/)
  assert.match(statusStore, /logs\.value\.length > LOG_CACHE_LIMIT/)
  assert.match(panel, /limit: LOG_CACHE_LIMIT/)
})

test('筛选启用时不被 WS 全量快照覆盖', () => {
  const start = statusStore.indexOf('function handleRealtimeLogsSnapshot')
  assert.ok(start >= 0, '应存在快照处理函数')
  const body = statusStore.slice(start, start + 600)
  assert.match(body, /if \(!realtimeLogsEnabled\.value\)\s+return/, '筛选期间暂停实时日志，快照也必须跳过')
})

test('展示前剥掉后端「同样状态重复 N 次」后缀，避免与 ×N 双重计数', () => {
  assert.match(statusStore, /const MERGED_SUFFIX_RE = \/（同样状态重复 \\d\+ 次，已合并）\\s\*\$/)
  assert.match(statusStore, /msg: typeof entry\.msg === 'string' \? entry\.msg\.replace\(MERGED_SUFFIX_RE, ''\)/)
})
