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

test('首页日志区只剩 RunLogPanel，旧工具栏实现不会复活', () => {
  assert.match(dashboard, /<RunLogPanel default-module="farm"/)
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
