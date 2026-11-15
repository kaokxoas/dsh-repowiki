/**
 * engine.test.js —— 引擎回归用例（node --test，零依赖）
 * ---------------------------------------------------------------------------
 * 跑法：node --test D:/WORK/repowiki/test/
 *
 * 这些用例锁的是「已经踩过的坑」，不是覆盖率：
 *   1) stripSourceRoot —— Maven 的 src/main/java 不能被当成包名
 *   2) pageRank      —— 悬挂节点不能让复杂度退化成 O(n^2)，且数值要正确
 *   3) resolveImport —— 三种解析风格（Java FQCN / JS 路径 / Python 模块）
 *   4) walkProject   —— 跳过规则：构建产物、隐藏目录、符号链接
 *   5) buildWiki     —— manifest 只删自己写过的页，绝不碰别人手写的页
 *   6) rankDiff      —— 按改动量×被依赖度排序，未跟踪文件单列
 *   7) coverageReport—— 跳过项与「推不出来」的边界要如实写出来
 *
 * 每个用例都在临时目录里造最小夹具，不依赖本机任何真实项目。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

import {
  stripSourceRoot,
  pageRank,
  resolveImport,
  walkProject,
  buildWiki,
  rankDiff,
  coverageReport,
} from '../lib/engine.js'

/* ------------------------------------------------------------------ 夹具 */

function tempDir(prefix = 'repowiki-test-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

/**
 * 删除临时目录。Windows 上 git 刚写完可能还占着 .git 里的句柄，rmSync 会抛 EPERM。
 * 清理失败不影响用例结论（临时目录会被系统回收），所以试两次就放手，
 * 绝不在这里自旋等待——否则每条用例都会被拖慢一两秒。
 */
function cleanup(dir) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch {
      /* 句柄未释放，放弃清理 */
    }
  }
}

function write(root, rel, content) {
  const abs = join(root, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content, 'utf8')
}

/* ------------------------------------------------------------------ 1. stripSourceRoot */

test('stripSourceRoot: 截掉 Maven 源码根，只留包路径', () => {
  assert.equal(
    stripSourceRoot('phenix-aidp-aegis/phenix-aidp-aegis-api/src/main/java/com/topdata/phenix/aegis/common'),
    'com/topdata/phenix/aegis/common',
  )
})

test('stripSourceRoot: 没有源码根时原样返回', () => {
  assert.equal(stripSourceRoot('com/plain/dir'), 'com/plain/dir')
  assert.equal(stripSourceRoot('.'), '.')
})

test('stripSourceRoot: 支持 test / kotlin / scala / groovy 与 Android 变体', () => {
  assert.equal(stripSourceRoot('module/src/test/kotlin/org/demo'), 'org/demo')
  assert.equal(stripSourceRoot('app/src/main/java/com/x'), 'com/x')
  assert.equal(stripSourceRoot('core/src/debug/java/com/y'), 'com/y')
})

test('stripSourceRoot: 源根正好是全部目录时返回空串（默认包）', () => {
  assert.equal(stripSourceRoot('app/src/main/java'), '')
})

/* ------------------------------------------------------------------ 2. pageRank */

test('pageRank: 无出边的悬挂节点不拖慢计算（回归 O(n^2) 事故）', () => {
  const n = 3000
  const nodes = Array.from({ length: n }, (_, k) => 'f' + k)
  const started = Date.now()
  pageRank(nodes, [])
  const elapsed = Date.now() - started
  // 旧实现在 n=3000、edges=0 时约 10 秒；修好后应在百毫秒级。
  // 阈值放宽到 3000ms，避免在慢机器上误报。
  assert.ok(elapsed < 3000, `pageRank 在 ${n} 个悬挂节点上用了 ${elapsed}ms，疑似退回 O(n^2)`)
})

test('pageRank: 悬挂节点权重被均分，全体分数之和约等于 1', () => {
  const nodes = ['a', 'b', 'c', 'd']
  const edges = [{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }]
  const ranked = pageRank(nodes, edges)
  const sum = ranked.reduce((acc, row) => acc + row.score, 0)
  assert.ok(Math.abs(sum - 1) < 0.01, `分数之和 ${sum} 偏离 1 太多`)
})

test('pageRank: 被引用多的文件排在前面', () => {
  const nodes = ['hub', 'a', 'b', 'c', 'leaf']
  const edges = [
    { from: 'a', to: 'hub' }, { from: 'b', to: 'hub' }, { from: 'c', to: 'hub' },
    { from: 'a', to: 'leaf' },
  ]
  const ranked = pageRank(nodes, edges)
  const posHub = ranked.findIndex((r) => r.file === 'hub')
  const posLeaf = ranked.findIndex((r) => r.file === 'leaf')
  assert.ok(posHub < posLeaf, '被 3 个文件引用的 hub 应排在只被 1 个文件引用的 leaf 之前')
})

test('pageRank: 结果是确定性的（同输入两次运行一致）', () => {
  const nodes = ['a', 'b', 'c']
  const edges = [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'a' }]
  assert.deepEqual(pageRank(nodes, edges), pageRank(nodes, edges))
})

/* ------------------------------------------------------------------ 3. resolveImport */

test('resolveImport: Java 的 import 用 FQCN 命中源码文件', () => {
  const byRel = new Map([['pkg/R.java', {}]])
  const packageIndex = new Map([['com.demo.pkg.R', 'pkg/R.java']])
  const hit = resolveImport('pkg/Consumer.java', 'com.demo.pkg.R', 'fqcn', byRel, packageIndex, new Map())
  assert.equal(hit, 'pkg/R.java')
})

test('resolveImport: FQCN 逐级回退，能命中外层包索引', () => {
  const byRel = new Map([['pkg/R.java', {}]])
  const packageIndex = new Map([['com.demo.pkg.R', 'pkg/R.java']])
  // 写的是内部类 com.demo.pkg.R.Inner，应回退到 com.demo.pkg.R
  const hit = resolveImport('pkg/Consumer.java', 'com.demo.pkg.R.Inner', 'fqcn', byRel, packageIndex, new Map())
  assert.equal(hit, 'pkg/R.java')
})

test('resolveImport: 解析不到的外部依赖返回 null，不瞎猜', () => {
  const hit = resolveImport('pkg/A.java', 'java.util.List', 'fqcn', new Map(), new Map(), new Map())
  assert.equal(hit, null)
})

test('resolveImport: JS 相对路径解析（含 index 与扩展名补全）', () => {
  const byRel = new Map([['src/util.ts', {}], ['src/lib/index.js', {}]])
  const hitA = resolveImport('src/app.ts', './util', 'path', byRel, new Map(), new Map())
  assert.equal(hitA, 'src/util.ts')
  const hitB = resolveImport('src/app.ts', './lib', 'path', byRel, new Map(), new Map())
  assert.equal(hitB, 'src/lib/index.js')
})

test('resolveImport: 裸模块名（npm 包）不算仓库内依赖', () => {
  const hit = resolveImport('src/app.ts', 'react', 'path', new Map(), new Map(), new Map())
  assert.equal(hit, null)
})

test('resolveImport: Python 模块名按 stem 命中', () => {
  const stemIndex = new Map([['helpers', ['py/helpers.py']]])
  const hit = resolveImport('py/main.py', 'pkg.helpers', 'module', new Map(), new Map(), stemIndex)
  assert.equal(hit, 'py/helpers.py')
})

/* ------------------------------------------------------------------ 4. walkProject */

test('walkProject: 跳过构建产物与依赖目录，并记录跳过原因', () => {
  const root = tempDir()
  try {
    write(root, 'src/a.ts', 'export const a = 1')
    write(root, 'node_modules/pkg/index.js', 'module.exports = 1')
    write(root, 'target/classes/A.class', 'x')
    write(root, '.git/config', 'x')
    write(root, 'dist/bundle.js', 'x')
    const { files, skipped } = walkProject(root)
    const rels = files.map((f) => f.rel)
    assert.deepEqual(rels, ['src/a.ts'])
    const reasons = skipped.map((s) => s.reason)
    assert.ok(reasons.some((r) => r.includes('构建产物')), '应记录构建产物跳过原因')
  } finally {
    cleanup(root)
  }
})

test('walkProject: 不跟随符号链接（防止环与越界）', (t) => {
  const root = tempDir()
  const outside = tempDir('repowiki-outside-')
  try {
    write(outside, 'secret.ts', 'nope')
    write(root, 'src/a.ts', 'ok')
    try {
      symlinkSync(outside, join(root, 'link'), 'junction')
    } catch {
      t.skip('当前环境不允许创建符号链接')
      return
    }
    const { files, skipped } = walkProject(root)
    assert.deepEqual(files.map((f) => f.rel), ['src/a.ts'])
    assert.ok(skipped.some((s) => s.reason.includes('符号链接')))
  } finally {
    cleanup(root)
    cleanup(outside)
  }
})

test('walkProject: 结果按路径排序，保证可复现', () => {
  const root = tempDir()
  try {
    write(root, 'z.ts', 'x')
    write(root, 'a.ts', 'x')
    write(root, 'm/b.ts', 'x')
    const { files } = walkProject(root)
    const rels = files.map((f) => f.rel)
    assert.deepEqual(rels, [...rels].sort())
  } finally {
    cleanup(root)
  }
})

/* ------------------------------------------------------------------ 5. buildWiki */

test('buildWiki: 产出七件套，data.js 可被 JSON 反解', () => {
  const root = tempDir()
  const out = tempDir('repowiki-out-')
  try {
    write(root, 'src/a.ts', 'export function alpha() {}\n')
    write(root, 'pom.xml', '<project/>')
    const result = buildWiki(root, out, {}, () => {})
    // 非 git 仓库时不出 history 页；没有 TODO 时不出 todos 页
    for (const required of ['overview.md', 'structure.md', 'deps.md', 'symbols.md', 'coverage.md']) {
      assert.ok(result.pages.includes(required), `缺少 ${required}`)
    }
    assert.ok(!result.pages.includes('history.md'), '非 git 仓库不应生成 history 页')
    for (const name of ['tree.json', 'status.json', 'data.js', '.repowiki-manifest.json']) {
      assert.ok(existsSync(join(out, name)), `缺少 ${name}`)
    }
    const raw = readFileSync(join(out, 'data.js'), 'utf8')
    const json = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1))
    assert.ok(Array.isArray(json.tree))
    assert.ok(json.pages && typeof json.pages === 'object')
    assert.ok(Array.isArray(json.order))
  } finally {
    cleanup(root)
    cleanup(out)
  }
})

test('buildWiki: 重扫只删自己 manifest 里记过的页，手写页必须留着', () => {
  const root = tempDir()
  const out = tempDir('repowiki-out-')
  try {
    write(root, 'src/a.ts', 'export function alpha() {}\n')
    buildWiki(root, out, {}, () => {})

    // 用户手写一页，并在树的同组里挂上它（模拟真实站点的做法）
    const handWritten = join(out, 'pages', 'my-notes.md')
    writeFileSync(handWritten, '# 我自己写的\n\n不要删我\n', 'utf8')
    buildWiki(root, out, {}, () => {})
    assert.ok(existsSync(handWritten), '重扫把手写页删掉了——manifest 只该删自己写过的页')
  } finally {
    cleanup(root)
    cleanup(out)
  }
})

test('buildWiki: 项目目录只读——扫描不改动源码', () => {
  const root = tempDir()
  const out = tempDir('repowiki-out-')
  try {
    const file = 'src/a.ts'
    write(root, file, 'export const original = 1\n')
    const before = readFileSync(join(root, file), 'utf8')
    buildWiki(root, out, {}, () => {})
    assert.equal(readFileSync(join(root, file), 'utf8'), before)
  } finally {
    cleanup(root)
    cleanup(out)
  }
})

test('buildWiki: 项目不存在时抛错，不静默成功', () => {
  const out = tempDir('repowiki-out-')
  try {
    assert.throws(() => buildWiki(join(out, 'no-such-project'), out, {}, () => {}), /项目目录不存在/)
  } finally {
    cleanup(out)
  }
})

/* ------------------------------------------------------------------ 6. rankDiff */

function gitInit(root) {
  const opts = { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  execFileSync('git', ['init', '-b', 'main'], opts)
  execFileSync('git', ['config', 'user.email', 'test@example.com'], opts)
  execFileSync('git', ['config', 'user.name', 'test'], opts)
}

function gitCommitAll(root, message) {
  const opts = { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  execFileSync('git', ['add', '-A'], opts)
  execFileSync('git', ['commit', '-m', message], opts)
}

test('rankDiff: 被大量依赖的文件权重大于孤立文件', () => {
  const root = tempDir()
  try {
    gitInit(root)
    // hub 被 5 个文件引用；lonely 没人引用
    write(root, 'src/hub.ts', 'export const hub = 1\n')
    write(root, 'src/lonely.ts', 'export const lonely = 1\n')
    for (let i = 0; i < 5; i += 1) write(root, `src/user${i}.ts`, "import { hub } from './hub'\n")
    gitCommitAll(root, 'init')

    // 两个文件改同样多的行（各 +2）
    write(root, 'src/hub.ts', 'export const hub = 1\nexport const hub2 = 2\nexport const hub3 = 3\n')
    write(root, 'src/lonely.ts', 'export const lonely = 1\nexport const l2 = 2\nexport const l3 = 3\n')

    const report = rankDiff(root, 'HEAD')
    const hub = report.files.find((f) => f.file === 'src/hub.ts')
    const lonely = report.files.find((f) => f.file === 'src/lonely.ts')
    assert.ok(hub && lonely, '两个改动文件都应在报告里')
    assert.equal(hub.churn, lonely.churn, '两个文件改动行数相同（前提条件）')
    assert.ok(hub.weight > lonely.weight, `被依赖的 hub 权重(${hub.weight})应大于 lonely(${lonely.weight})`)
    assert.equal(report.files[0].file, 'src/hub.ts', 'hub 应排第一')
  } finally {
    cleanup(root)
  }
})

test('rankDiff: 未跟踪的新增文件不进权重排序，单独列出', () => {
  const root = tempDir()
  try {
    gitInit(root)
    write(root, 'src/a.ts', 'export const a = 1\n')
    gitCommitAll(root, 'init')
    write(root, 'src/brand-new.ts', 'export const n = 1\n')

    const report = rankDiff(root, 'HEAD')
    assert.equal(report.filesChanged, 0, '已跟踪文件没有改动')
    assert.ok(report.untracked.includes('src/brand-new.ts'), '新增文件应出现在 untracked 里')
  } finally {
    cleanup(root)
  }
})

test('rankDiff: 非 git 目录返回空报告而不是抛错', () => {
  const root = tempDir()
  try {
    write(root, 'src/a.ts', 'x')
    const report = rankDiff(root, 'HEAD')
    assert.equal(report.filesChanged, 0)
    assert.deepEqual(report.files, [])
  } finally {
    cleanup(root)
  }
})

/* ------------------------------------------------------------------ 7. coverageReport */

test('coverageReport: 如实报告跳过项与「推不出来」的边界', () => {
  const root = tempDir()
  try {
    write(root, 'src/a.ts', 'export const a = 1\n')
    write(root, 'node_modules/x/index.js', 'x')
    const report = coverageReport(root)
    assert.equal(report.filesScanned, 1)
    assert.equal(report.sourceFiles, 1)
    assert.ok(report.skipped.some((s) => s.reason.includes('构建产物')))
    assert.ok(report.limits.length >= 3, '应至少列出三条静态分析推不出来的东西')
    assert.ok(report.limits.some((l) => l.includes('运行')), '应明说不看运行时行为')
    assert.equal(report.truncated, false)
  } finally {
    cleanup(root)
  }
})

test('coverageReport: 没有 git 仓库时 hasGit 为 false，不抛错', () => {
  const root = tempDir()
  try {
    write(root, 'src/a.ts', 'x')
    const report = coverageReport(root)
    assert.equal(report.hasGit, false)
    assert.equal(report.head, null)
  } finally {
    cleanup(root)
  }
})
