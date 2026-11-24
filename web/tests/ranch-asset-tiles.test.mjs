import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import test from 'node:test'

/**
 * 牧场首页「资产」瓦片：金券 / 点券 / 松果 / 便便，
 * 第三行显示本次运行增量（口径与农场首页资产卡一致）。
 *
 * 顺序是产品定的：金豆豆换成便便之后，再和松果互换位置。
 */

const source = readFileSync(new URL('../src/views/RanchOverview.vue', import.meta.url), 'utf8')
const dashboard = readFileSync(new URL('../src/views/Dashboard.vue', import.meta.url), 'utf8')

test('资产瓦片顺序：金券 → 点券 → 松果 → 便便', () => {
  const block = source.match(/const ASSET_IDS = \[([^\]]*)\]/)
  assert.ok(block, 'RanchOverview.vue 里要有 ASSET_IDS 清单')
  assert.deepEqual(block[1].split(',').map(item => item.trim()).filter(Boolean), ['1007', '1002', '1008', '7002'])
})

test('金豆豆（1005）退出资产卡，便便（7002）按纯数量格式化', () => {
  assert.ok(!/1005:\s*formatGoldBeanAmount/.test(source), '金豆豆的格式化项应删掉')
  assert.match(source, /7002: formatCount/)
  assert.ok(!source.includes('formatGoldBeanAmount'), '不再引用的格式化函数要一并去掉')
})

test('四项数值下方显示「本次」增量，写法与农场首页资产卡一致', () => {
  // 农场首页的参考写法：本次 +N / -N，正数补 +，负数自带负号，0 不显示。
  assert.match(dashboard, /ov-tile__delta/)
  assert.match(dashboard, /本次 \{\{ \(status\?\.runGoldGained \|\| 0\) > 0 \? '\+' : '' \}\}/)

  assert.match(source, /const runCurrencyMap = computed<Record<string, any>>\(\(\) => \(state\.value\?\.currencyRun \|\| \{\}\)\)/)
  assert.match(source, /deltaText: `\$\{delta > 0 \? '\+' : ''\}\$\{formatCount\(delta\)\}`/)
  assert.match(source, /v-if="item\.delta !== 0" class="ov-tile__delta"/)
  assert.match(source, /本次 \{\{ item\.deltaText \}\}/)
  // 配色沿用统一变量：涨用主色、跌用危险色。
  assert.match(source, /item\.delta > 0 \? 'is-up' : 'is-down'/)
})
