import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import test from 'node:test'

const read = relative => readFileSync(new URL(relative, import.meta.url), 'utf8')
const dashboard = read('../src/views/Dashboard.vue')
const panel = read('../src/components/RunLogPanel.vue')

test('首页不再挂载运行诊断模块', () => {
  assert.doesNotMatch(dashboard, /RuntimeDiagnosticsCard/)
  assert.doesNotMatch(dashboard, /运行诊断/)
})

test('首页日志区只剩统一日志视图，旧工具栏实现不会复活', () => {
  // 农场首页与牧场首页共用 RunLogCard 外壳，日志实现只有 RunLogPanel 一份。
  assert.match(dashboard, /<RunLogCard[\s\S]{0,200}default-module="farm"/)
  assert.ok(!dashboard.includes('<RunLogPanel'), '首页应通过外壳挂载，避免两处布局再次分叉')
  // 这两族类名属于已被统一组件取代的旧实现，留在首页就会与组件抢同一块区域。
  assert.ok(!dashboard.includes('.dashboard-log-toolbar'), '旧日志工具栏样式不应回到首页')
  assert.ok(!dashboard.includes('.log-filters {'), '旧筛选区样式不应回到首页')
})

test('宽的筛选区按列铺开，不折成多行', () => {
  const start = panel.indexOf('@media (min-width: 640px)')
  assert.ok(start >= 0, 'RunLogPanel 应保留宽屏断点')
  const wide = panel.slice(start, panel.indexOf('\n}\n', start))
  assert.match(wide, /grid-template-columns:\s*repeat\(5, minmax\(0, 8rem\)\) auto/, '五个筛选项 + 按钮列同一行')
})
