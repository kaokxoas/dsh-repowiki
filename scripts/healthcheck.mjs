#!/usr/bin/env node
/**
 * healthcheck.mjs —— 插件装配自检
 * ---------------------------------------------------------------------------
 * 用法：node D:/WORK/repowiki/scripts/healthcheck.mjs
 *
 * 检查 6 类东西，前 5 类都能从进程外可靠判定：
 *   1. profile 的 dsh.profile.bundles 里有本包（否则重启后不会自动装配）
 *   2. profile 的 dependencies 是 link: 指向源仓库（否则按包名解析不到）
 *   3. node_modules 下的 junction 能解析出真实文件
 *   4. package.json 的 dsh.bundle.patch 指向的文件存在、无 TAB、含 - insert:
 *   5. lib/index.js 可 import，导出 apply 与 inject
 *   6. HTTP /health（参考项，不计入失败 —— 见下方说明）
 *
 * 关于第 6 项：实测 2026-11-15，本脚本若由宿主进程（DeepSeek Harness.exe）fork 出来跑，
 * 访问宿主自己监听的 127.0.0.1:34572 会超时，即使 netstat 显示 LISTENING、宿主内 fetch 返回 200；
 * 换成普通 node（D:\soft\Node\node.exe）跑则正常。这是执行环境的行为，不是插件缺陷，
 * 所以只打印参考值，不让它把结论翻成失败——否则会误导人反复重装。
 *
 * 「四个工具是否注册」只能从宿主进程内看，本脚本查不到，需要让 agent 查。
 *
 * 退出码：0 前 5 类全过 / 1 有问题 / 2 前置路径不对
 */
import { readFileSync, existsSync, realpathSync } from 'node:fs'
import { request, createServer } from 'node:http'
import { pathToFileURL } from 'node:url'

const PKG = '@dsh-external/dsh-repowiki'
const PROFILE_DIR = process.env.DSH_PROFILE_DIR || 'C:/Users/Administrator/.dsh/profiles/desktop'
const HEALTH_PORT = 34572
const HEALTH_PATH = '/@dsh-external/dsh-repowiki/api/health'

const problems = []
const notes = []
const ok = (msg) => console.log('  [v] ' + msg)
const bad = (msg) => {
  problems.push(msg)
  console.log('  [X] ' + msg)
}
const note = (msg) => {
  notes.push(msg)
  console.log('  [-] ' + msg)
}

/* ---------------------------------------------------------------- 1 & 2 */

console.log('插件装配自检：' + PKG)
console.log('profile：' + PROFILE_DIR)
console.log('')

const profilePkgPath = PROFILE_DIR + '/package.json'
if (!existsSync(profilePkgPath)) {
  console.error('路径不对，找不到 profile package.json：' + profilePkgPath)
  process.exit(2)
}

const profilePkg = JSON.parse(readFileSync(profilePkgPath, 'utf8'))
const bundles = (profilePkg.dsh && profilePkg.dsh.profile && profilePkg.dsh.profile.bundles) || []
const deps = profilePkg.dependencies || {}

console.log('装配声明')
if (bundles.includes(PKG)) ok('bundles 里登记了本包（共 ' + bundles.length + ' 个）')
else bad('bundles 里没有本包 —— 重启后不会自动装配')

const dep = deps[PKG]
if (typeof dep === 'string' && dep.startsWith('link:')) ok('dependencies 是 link：' + dep)
else if (dep) bad('dependencies 不是 link:（' + dep + '），重启后可能拉到别的版本')
else bad('dependencies 里没有本包 —— loader 无法按包名解析')

/* ---------------------------------------------------------------- 3 & 4 */

console.log('')
console.log('链接与产物')
const linkPath = PROFILE_DIR + '/node_modules/' + PKG
let resolved = null
try {
  resolved = realpathSync(linkPath)
  ok('junction 解析到 ' + resolved)
} catch (error) {
  bad('junction 不可用（' + error.code + '）—— 需要重建链接')
}

if (resolved) {
  if (existsSync(resolved + '/lib/index.js')) ok('入口文件存在：lib/index.js')
  else bad('入口文件缺失：' + resolved + '/lib/index.js')

  const pkgPath = resolved + '/package.json'
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    const patchRel = pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch
    if (!patchRel) {
      bad('package.json 缺 dsh.bundle.patch —— loader 展开后不会有任何 entry')
    } else if (!existsSync(resolved + '/' + patchRel)) {
      bad('patch 文件不存在：' + patchRel)
    } else {
      ok('dsh.bundle.patch 存在：' + patchRel)
      const yml = readFileSync(resolved + '/' + patchRel, 'utf8')
      const tabLines = yml.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => l.includes('\t'))
      if (tabLines.length) bad('patch 里有 TAB（第 ' + tabLines.map(([n]) => n).join(',') + ' 行）—— YAML 会解析失败')
      else ok('patch 无 TAB')
      if (/^- insert:/m.test(yml)) ok('patch 含 - insert:')
      else bad('patch 缺 - insert: —— loader 不会创建 entry')
      if (yml.includes('"' + PKG + '"')) ok('patch 里包名引号完整')
      else bad('patch 里包名写法可疑')
    }
  }
}

/* ---------------------------------------------------------------- 5 */

console.log('')
console.log('模块可加载性')
if (resolved) {
  try {
    const ns = await import(pathToFileURL(resolved + '/lib/index.js').href + '?t=' + Date.now())
    if (typeof ns.apply === 'function') ok('导出 apply')
    else bad('没有导出 apply')
    if (Array.isArray(ns.inject)) {
      ok('inject = ' + JSON.stringify(ns.inject))
      const unknown = ns.inject.filter((name) => !['webServer', 'tools'].includes(name))
      if (unknown.length) bad('依赖了本插件不该用的服务：' + unknown.join(','))
    } else {
      bad('inject 不是数组')
    }
  } catch (error) {
    bad('import 失败：' + String(error && error.message).slice(0, 200))
  }
}

/* ---------------------------------------------------------------- 6 */

console.log('')
console.log('运行中的服务（参考项，不计入失败）')

function probeHealth() {
  return new Promise((resolve) => {
    const req = request(
      { host: '127.0.0.1', port: HEALTH_PORT, path: HEALTH_PATH, method: 'GET', timeout: 4000 },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => { body += chunk })
        res.on('end', () => resolve({ status: res.statusCode, body: body.trim() }))
      },
    )
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'TIMEOUT' }) })
    req.on('error', (error) => resolve({ status: 0, body: String(error.code || error.message) }))
    req.end()
  })
}

const health = await probeHealth()
if (health.status === 200 && health.body === 'ok') {
  ok('HTTP /health -> 200 ok')
} else {
  note('HTTP 探测未通过（' + (health.status || health.body) + '），本次不计入失败')
  console.log('      执行环境原因：宿主进程 fork 出来的子进程访问宿主自己监听的端口会超时（实测）')
  console.log('      要实测这一项，换普通 node 跑：')
  console.log('      D:\\soft\\Node\\node.exe D:/WORK/repowiki/scripts/healthcheck.mjs')
}

/* ---------------------------------------------------------------- 汇总 */

console.log('')
if (!problems.length) {
  console.log('[v] 装配检查全部通过（前 5 类）。')
  console.log('    四个工具是否注册只能从宿主进程内看 —— 让 agent 查一次即可。')
  if (notes.length) console.log('    参考项未通过：' + notes.join('；'))
  process.exit(0)
}

console.log('[X] 有 ' + problems.length + ' 个问题：')
for (const p of problems) console.log('    - ' + p)
console.log('')
console.log('常见修法：')
console.log('  · bundles 缺   → 把 "' + PKG + '" 加进 profile 的 dsh.profile.bundles')
console.log('  · junction 坏  → 重建 ' + linkPath + ' 指向 D:/WORK/repowiki')
console.log('  · patch 有问题 → 检查 cordis.patch.yml 是否有 - insert: 且无 TAB')
process.exit(1)
