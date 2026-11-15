/**
 * contract.test.js —— Host 契约层（node --test）
 * ---------------------------------------------------------------------------
 * 测的是 lib/contract.js 这个**真货**，不是复制品。lib/index.js 也 import 它，
 * 所以这里通过，就等于线上 Host 用的是同一套逻辑。
 *
 * 覆盖三类「错了会静默」的问题：
 *   1) readWikiBundle：前缀剥离、损坏不崩、缺失返回 null
 *   2) isValidPageId：路径穿越必须挡在路由层
 *   3) readWikiPage：非法 id 与缺文件都返回 null，不抛
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { API_PREFIX, isValidPageId, readWikiBundle, readWikiPage } from '../lib/contract.js'

function tempDir(prefix = 'repowiki-contract-') {
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

/* ------------------------------------------------------------------ API_PREFIX */

test('API_PREFIX: 带插件作用域，避免与宿主路由冲突', () => {
  assert.ok(API_PREFIX.startsWith('/@dsh-external/'), '路由必须挂在插件作用域下')
  assert.ok(API_PREFIX.endsWith('/api'), '应以 /api 结尾，便于区分静态资源')
})

/* ------------------------------------------------------------------ readWikiBundle */

test('readWikiBundle: 正确剥离 window.WIKI= 前缀与结尾分号', () => {
  const dir = tempDir()
  try {
    const payload = {
      tree: [{ id: 'generated', name: 'g', children: [] }],
      pages: { overview: '# hi' },
      order: ['overview'],
      status: { head: 'abc123', engine: '1.0.0' },
    }
    writeFileSync(join(dir, 'data.js'), 'window.WIKI=' + JSON.stringify(payload) + ';\n', 'utf8')
    const bundle = readWikiBundle(dir)
    assert.deepEqual(bundle.order, ['overview'])
    assert.equal(bundle.pages.overview, '# hi')
    assert.equal(bundle.status.head, 'abc123')
    assert.equal(bundle.error, undefined)
  } finally {
    cleanup(dir)
  }
})

test('readWikiBundle: 没有 data.js 返回 null（还没生成，不是错误）', () => {
  const dir = tempDir()
  try {
    assert.equal(readWikiBundle(dir), null)
  } finally {
    cleanup(dir)
  }
})

test('readWikiBundle: 目录不存在也返回 null，不抛', () => {
  assert.equal(readWikiBundle(join(tmpdir(), 'definitely-missing-repowiki-dir')), null)
})

test('readWikiBundle: data.js 损坏时返回 { error }，不抛', () => {
  const dir = tempDir()
  try {
    writeFileSync(join(dir, 'data.js'), 'window.WIKI={not valid json;;;', 'utf8')
    const bundle = readWikiBundle(dir)
    assert.ok(bundle && typeof bundle.error === 'string', '应返回带 error 的对象')
    assert.match(bundle.error, /解析失败/)
  } finally {
    cleanup(dir)
  }
})

test('readWikiBundle: 没有 window.WIKI= 前缀时按裸 JSON 解析', () => {
  const dir = tempDir()
  try {
    writeFileSync(join(dir, 'data.js'), JSON.stringify({ order: ['x'] }), 'utf8')
    assert.deepEqual(readWikiBundle(dir).order, ['x'])
  } finally {
    cleanup(dir)
  }
})

/* ------------------------------------------------------------------ isValidPageId */

test('isValidPageId: 正常 id 通过', () => {
  for (const id of ['overview', 'ref-flyway-fenhao-qieduan', 'a_b', 'a.b', 'A1', '0']) {
    assert.equal(isValidPageId(id), true, `${id} 应被允许`)
  }
})

test('isValidPageId: 路径穿越、分隔符与空串必须被拒', () => {
  const bad = [
    '../etc/passwd',
    '..\\win.ini',
    'a/b',
    'a\\b',
    '',
    'a b',
    'a:b',
    'a*b',
    'a?b',
    'a|b',
    '.',
    '..',
  ]
  for (const id of bad) {
    assert.equal(isValidPageId(id), false, `${JSON.stringify(id)} 不该通过`)
  }
})

test('isValidPageId: 非字符串一律拒（防止 undefined 被当合法）', () => {
  for (const value of [undefined, null, 1, {}, [], true]) {
    assert.equal(isValidPageId(value), false)
  }
})

/* ------------------------------------------------------------------ readWikiPage */

test('readWikiPage: 读到真实 markdown', () => {
  const dir = tempDir()
  try {
    mkdirSync(join(dir, 'pages'), { recursive: true })
    writeFileSync(join(dir, 'pages', 'overview.md'), '# 概览\n内容\n', 'utf8')
    assert.equal(readWikiPage(dir, 'overview'), '# 概览\n内容\n')
  } finally {
    cleanup(dir)
  }
})

test('readWikiPage: 非法 id 返回 null，不尝试拼路径', () => {
  const dir = tempDir()
  try {
    assert.equal(readWikiPage(dir, '../secret'), null)
    assert.equal(readWikiPage(dir, ''), null)
  } finally {
    cleanup(dir)
  }
})

test('readWikiPage: 页不存在返回 null', () => {
  const dir = tempDir()
  try {
    mkdirSync(join(dir, 'pages'), { recursive: true })
    assert.equal(readWikiPage(dir, 'nope'), null)
  } finally {
    cleanup(dir)
  }
})
