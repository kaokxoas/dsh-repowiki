/**
 * perf.test.js —— 性能护栏（node --test）
 * ---------------------------------------------------------------------------
 * 这些用例不测「有多快」，只测「不许退化成不可用」。
 * 阈值放得很宽，慢机器上不会误报，但 O(n^2) 这类事故会被立刻抓住。
 *
 * 锁的三件事：
 *   1) PageRank 在大量悬挂节点上必须是线性量级（回归过一次 O(n^2)）
 *   2) 中等规模仓库的 buildMap 不许超过 60 秒（本项目 14000 文件实测 4 秒）
 *   3) buildWiki 的写盘不随页面数平方增长
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { pageRank, buildMap, buildWiki } from '../lib/engine.js'

function tempDir(prefix = 'repowiki-perf-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

function cleanup(dir) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch {
      /* 交给系统回收 */
    }
  }
}

function write(root, rel, content) {
  const abs = join(root, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content, 'utf8')
}

test('perf: PageRank 10000 个悬挂节点必须在一秒内完成', () => {
  const nodes = Array.from({ length: 10000 }, (_, k) => 'f' + k + '.ts')
  const started = Date.now()
  pageRank(nodes, [])
  const elapsed = Date.now() - started
  // 旧实现按 O(n^2) 估算约 108 秒；修好后实测约 200ms。阈值 1000ms。
  assert.ok(elapsed < 1000, `10000 个悬挂节点用了 ${elapsed}ms，疑似退回 O(n^2)`)
})

test('perf: PageRank 在 10000 节点 + 5000 边时仍然线性', () => {
  const nodes = Array.from({ length: 10000 }, (_, k) => 'f' + k + '.ts')
  const edges = []
  for (let i = 0; i < 5000; i += 1) {
    edges.push({ from: nodes[i], to: nodes[(i * 7) % nodes.length] })
  }
  const started = Date.now()
  pageRank(nodes, edges)
  const elapsed = Date.now() - started
  assert.ok(elapsed < 2000, `10000 节点 5000 边用了 ${elapsed}ms`)
})

test('perf: 3000 个源文件的 buildMap 在 60 秒内完成', () => {
  const root = tempDir()
  try {
    // 造 3000 个 TS 文件，每个 import 前一个，形成一条长链
    const count = 3000
    for (let i = 0; i < count; i += 1) {
      const next = i + 1 < count ? `\nimport { f${i + 1} } from './m${i + 1}'` : ''
      write(root, `mod/m${i}.ts`, `export function f${i}() { return ${i} }${next}\n`)
    }
    const started = Date.now()
    const map = buildMap(root)
    const elapsed = Date.now() - started
    assert.equal(map.sourceFiles, count)
    assert.ok(map.edges.length >= count - 1, `应解析出至少 ${count - 1} 条边，实际 ${map.edges.length}`)
    assert.ok(elapsed < 60000, `3000 文件的 buildMap 用了 ${elapsed}ms，超过 60 秒护栏`)
  } finally {
    cleanup(root)
  }
})

test('perf: buildWiki 处理 500 个文件在 60 秒内完成', () => {
  const root = tempDir()
  const out = tempDir('repowiki-perf-out-')
  try {
    for (let i = 0; i < 500; i += 1) {
      write(root, `src/m${i}.ts`, `export function f${i}() { return ${i} }\n`)
    }
    const started = Date.now()
    const result = buildWiki(root, out, {}, () => {})
    const elapsed = Date.now() - started
    assert.ok(result.pages.length >= 5)
    assert.ok(elapsed < 60000, `500 文件的 buildWiki 用了 ${elapsed}ms`)
  } finally {
    cleanup(root)
    cleanup(out)
  }
})
