import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import test from 'node:test'

const dashboard = readFileSync(new URL('../src/views/Dashboard.vue', import.meta.url), 'utf8')

test('今日统计模块的数值后面不再带单位「次」', () => {
  assert.doesNotMatch(dashboard, />次<\/small>/, '金币/经验/动作项后面的「次」单位已全部移除')
  assert.doesNotMatch(dashboard, /todayGoldGained \}\}<small[^>]*>次</)
  assert.doesNotMatch(dashboard, /todayExpGained \}\}<small[^>]*>次</)
  assert.doesNotMatch(dashboard, /\{\{ val \}\}<small[^>]*>次</)
})

test('移除单位后仍保留数字、负数配色与动作统计列表', () => {
  assert.match(dashboard, /\{\{ todayGoldGained \}\}/)
  assert.match(dashboard, /\{\{ todayExpGained \}\}/)
  assert.match(dashboard, /\{\{ val \}\}/)
  assert.match(dashboard, /class="ov-today-gold text-sm font-bold 2xl:text-base" :class="\{ 'is-down': todayGoldGained < 0 \}"/)
  assert.match(dashboard, /v-for="\[key, val\] in operationGroups.active"/)
})

test('运行日志里的重复次数文案不受影响', () => {
  // 日志视图已收口到 RunLogPanel，重复次数的提示语跟着搬家。
  const panel = readFileSync(new URL('../src/components/RunLogPanel.vue', import.meta.url), 'utf8')
  assert.match(panel, /起重复 \$\{group\.count\} 次/)
})
