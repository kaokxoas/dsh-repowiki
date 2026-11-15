/**
 * cli.test.js —— 命令行入口的集成用例（node --test）
 * ---------------------------------------------------------------------------
 * 跑法：node --test D:/WORK/repowiki/test/
 *
 * 锁的是「CLI 契约」：退出码、输出形态、--json 可解析、默认输出目录不落在项目里。
 * 这些是模型和脚本真正依赖的东西，比文字措辞重要。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = join(HERE, '..', 'bin', 'repowiki.mjs')

function tempDir(prefix = 'repowiki-cli-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

function cleanup(dir) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch {
      /* 句柄未释放，交给系统回收 */
    }
  }
}

function write(root, rel, content) {
  const abs = join(root, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content, 'utf8')
}

/** 跑 CLI；process.execPath 在这里是真正的 node（不是 Electron），因为用例由 node --test 启动。 */
function runCli(args, cwd) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 120000,
    windowsHide: true,
  })
  return { code: result.status, stdout: result.stdout || '', stderr: result.stderr || '' }
}

function makeProject() {
  const root = tempDir()
  write(root, 'src/util.ts', 'export function helper() { return 1 }\n')
  write(root, 'src/app.ts', "import { helper } from './util'\nexport const app = helper()\n")
  write(root, 'package.json', JSON.stringify({ name: 'demo', scripts: { build: 'tsc -p .' } }, null, 2))
  write(root, 'README.md', '# demo\n')
  return root
}

/* ------------------------------------------------------------------ 元命令 */

test('CLI: help 退出码 0 且列出五个子命令', () => {
  const { code, stdout } = runCli(['help'], tmpdir())
  assert.equal(code, 0)
  for (const cmd of ['scan', 'map', 'diff', 'coverage', 'serve']) {
    assert.ok(stdout.includes(cmd), `help 里缺少 ${cmd}`)
  }
})

test('CLI: version 输出语义化版本号', () => {
  const { code, stdout } = runCli(['version'], tmpdir())
  assert.equal(code, 0)
  assert.match(stdout.trim(), /^\d+\.\d+\.\d+$/)
})

test('CLI: 未知命令退出码非 0 并把用法打到 stderr', () => {
  const { code, stderr } = runCli(['no-such-command'], tmpdir())
  assert.notEqual(code, 0)
  assert.ok(stderr.includes('未知命令'), 'stderr 应说明是未知命令')
})

/* ------------------------------------------------------------------ scan */

test('CLI scan: 产出七件套，退出码 0', () => {
  const project = makeProject()
  const out = tempDir('repowiki-scan-')
  try {
    const { code, stdout } = runCli(['scan', project, '--out', out], tmpdir())
    assert.equal(code, 0, stdout)
    for (const name of ['tree.json', 'status.json', 'data.js', '.repowiki-manifest.json', 'pages']) {
      assert.ok(existsSync(join(out, name)), `缺少 ${name}`)
    }
  } finally {
    cleanup(project)
    cleanup(out)
  }
})

test('CLI scan --json: 输出可被 JSON.parse，含 pages 与 outDir', () => {
  const project = makeProject()
  const out = tempDir('repowiki-scan-')
  try {
    const { code, stdout } = runCli(['scan', project, '--out', out, '--json'], tmpdir())
    assert.equal(code, 0)
    const json = JSON.parse(stdout.slice(stdout.indexOf('{')))
    assert.ok(Array.isArray(json.pages))
    assert.equal(typeof json.outDir, 'string')
    assert.equal(typeof json.ms, 'number')
  } finally {
    cleanup(project)
    cleanup(out)
  }
})

test('CLI scan: 不指定 --out 时输出到项目的同级目录，不写进项目里', () => {
  const parent = tempDir('repowiki-parent-')
  const project = join(parent, 'myrepo')
  try {
    write(project, 'src/a.ts', 'export const a = 1\n')
    const before = readFileSync(join(project, 'src/a.ts'), 'utf8')
    const { code } = runCli(['scan', project], parent)
    assert.equal(code, 0)
    assert.ok(existsSync(join(parent, 'repowiki-out', 'data.js')), '默认输出应在 <项目父目录>/repowiki-out')
    assert.equal(readFileSync(join(project, 'src/a.ts'), 'utf8'), before, '项目源码不能被改动')
    assert.ok(!existsSync(join(project, 'repowiki-out')), '输出目录绝不能落进项目里')
  } finally {
    cleanup(parent)
  }
})

test('CLI scan: 项目不存在时退出码 2，不静默成功', () => {
  const { code, stderr } = runCli(['scan', join(tmpdir(), 'definitely-not-here')], tmpdir())
  assert.equal(code, 2)
  assert.ok(stderr.includes('不存在'))
})

/* ------------------------------------------------------------------ map */

test('CLI map: markdown 形态含阅读顺序与规模表', () => {
  const project = makeProject()
  try {
    const { code, stdout } = runCli(['map', project], tmpdir())
    assert.equal(code, 0)
    assert.ok(stdout.includes('阅读顺序'), '应有阅读顺序小节')
    assert.ok(stdout.includes('规模'), '应有规模小节')
    assert.ok(stdout.includes('src/app.ts') || stdout.includes('src/util.ts'), '应列出真实文件')
  } finally {
    cleanup(project)
  }
})

test('CLI map --format json: 顶层键固定，ranking 是数组', () => {
  const project = makeProject()
  try {
    const { code, stdout } = runCli(['map', project, '--format', 'json', '--top', '5'], tmpdir())
    assert.equal(code, 0)
    const json = JSON.parse(stdout)
    for (const key of ['projectDir', 'filesScanned', 'sourceFiles', 'symbols', 'edges', 'ranking']) {
      assert.ok(key in json, `缺少键 ${key}`)
    }
    assert.ok(Array.isArray(json.ranking))
    assert.ok(json.ranking.length <= 5, '--top 应限制返回条数')
  } finally {
    cleanup(project)
  }
})

test('CLI map: 能解析出 app.ts -> util.ts 的依赖（Windows 路径回归）', () => {
  const project = makeProject()
  try {
    const { code, stdout } = runCli(['map', project, '--format', 'json'], tmpdir())
    assert.equal(code, 0)
    const json = JSON.parse(stdout)
    const hit = json.edges.some((e) => e.from === 'src/app.ts' && e.to === 'src/util.ts')
    assert.ok(hit, `JS 相对 import 没有解析出来：${JSON.stringify(json.edges)}`)
  } finally {
    cleanup(project)
  }
})

/* ------------------------------------------------------------------ coverage */

test('CLI coverage: 含跳过表与「推不出来的东西」', () => {
  const project = makeProject()
  try {
    write(project, 'node_modules/x/index.js', 'x')
    const { code, stdout } = runCli(['coverage', project], tmpdir())
    assert.equal(code, 0)
    assert.ok(stdout.includes('覆盖报告'))
    assert.ok(stdout.includes('跳过'))
    assert.ok(stdout.includes('推不出来的东西'))
  } finally {
    cleanup(project)
  }
})

test('CLI coverage --json: limits 是数组且非空', () => {
  const project = makeProject()
  try {
    const { code, stdout } = runCli(['coverage', project, '--json'], tmpdir())
    assert.equal(code, 0)
    const json = JSON.parse(stdout)
    assert.ok(Array.isArray(json.limits) && json.limits.length >= 3)
    assert.equal(typeof json.filesScanned, 'number')
  } finally {
    cleanup(project)
  }
})

/* ------------------------------------------------------------------ diff */

test('CLI diff: 非 git 目录退出码 0 并给空报告', () => {
  const project = makeProject()
  try {
    const { code, stdout } = runCli(['diff', project], tmpdir())
    assert.equal(code, 0)
    assert.ok(stdout.includes('Review 顺序'))
    assert.ok(stdout.includes('没有已跟踪文件的改动'))
  } finally {
    cleanup(project)
  }
})

test('CLI diff --json: 键齐全', () => {
  const project = makeProject()
  try {
    const { code, stdout } = runCli(['diff', project, 'HEAD', '--json'], tmpdir())
    assert.equal(code, 0)
    const json = JSON.parse(stdout)
    for (const key of ['range', 'files', 'untracked', 'totalAdded', 'totalDeleted', 'filesChanged']) {
      assert.ok(key in json, `缺少键 ${key}`)
    }
  } finally {
    cleanup(project)
  }
})

/* ------------------------------------------------------------------ serve */

test('CLI serve: 只打印地址不常驻（常驻服务由插件提供）', () => {
  const { code, stdout } = runCli(['serve', '--port', '34999'], tmpdir())
  assert.equal(code, 0)
  assert.ok(stdout.includes('34999'))
  assert.ok(stdout.includes('插件'), '应说明常驻服务由插件提供')
})
