import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import test from 'node:test'

/**
 * 牧场首页「今日统计」瓦片的展示顺序。
 *
 * 顺序是产品反复调过的结果（金券 / 经验 / 便便 / 松果 / 出售 / 偷取 / 清理 / 放蚊子），
 * 之前靠 todayTiles 的拼接顺序隐式表达，改一处容易连带打乱别处，所以收敛成
 * TODAY_TILE_ORDER 一张表。这里锁住表内容与「确实按表排」这件事。
 */

const source = readFileSync(new URL('../src/views/RanchOverview.vue', import.meta.url), 'utf8')

function tileOrder() {
  const block = source.match(/const TODAY_TILE_ORDER = \[([\s\S]*?)\]/)
  assert.ok(block, 'RanchOverview.vue 里要有 TODAY_TILE_ORDER 顺序表')
  return [...block[1].matchAll(/'([^']+)'/g)].map(match => match[1])
}

test('今日统计瓦片顺序：金券 → 经验 → 便便 → 松果 → 出售 → 偷取 → 清理 → 放蚊子', () => {
  assert.deepEqual(tileOrder(), [
    'currency-1007',
    'today-exp',
    'currency-7002',
    'currency-1008',
    'action-sell',
    'action-steal',
    'action-clean',
    'action-putMosquito',
  ])
})

test('todayTiles 按顺序表排序，未列出的动作排末尾', () => {
  assert.match(source, /const todayTiles = computed\(\(\) => \{/, 'todayTiles 必须是带排序的实现，不能退回直接拼接')
  assert.match(source, /TODAY_TILE_ORDER\.indexOf\(key\)/, '要用顺序表取 rank')
  assert.match(source, /index < 0 \? TODAY_TILE_ORDER\.length : index/, '不在表里的 key 排到最后')
  assert.match(source, /sort\(\(a, b\) => rankOf\(a\.key\) - rankOf\(b\.key\)\)/, '按 rank 排序')
})

test('顺序表里的 key 都能被现有瓦片生成出来', () => {
  // currency-<id> 来自 RANCH_TODAY_CURRENCIES，action-<key> 来自 RANCH_TODAY_ACTIONS，
  // today-exp 是单独的 expTile。表里写错 key 会让该瓦片静默掉到末尾。
  const currencyIds = [...source.matchAll(/\{ id: (\d+), label:/g)].map(match => `currency-${match[1]}`)
  const actionKeys = [...source.matchAll(/\{ key: '([a-zA-Z]+)', label:/g)].map(match => `action-${match[1]}`)
  const known = new Set([...currencyIds, ...actionKeys, 'today-exp'])

  for (const key of tileOrder()) assert.ok(known.has(key), `${key} 要能对应到实际瓦片`)
  assert.ok(currencyIds.length >= 3, '金券/松果/便便三个货币瓦片都要还在')
})
