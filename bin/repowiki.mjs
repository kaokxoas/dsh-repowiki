#!/usr/bin/env node
/**
 * repowiki —— 命令行入口
 * ---------------------------------------------------------------------------
 *   repowiki scan <项目根> [--out DIR] [--json]
 *   repowiki map  <项目根> [--format json|md] [--top N]
 *   repowiki diff <项目根> [range] [--json]
 *   repowiki coverage <项目根> [--json]
 *   repowiki serve [--port 34571]
 *
 * 全部确定性地算：不联网、不调模型、不写项目目录（除非 --out 指向项目内）。
 */
import { resolve, join, dirname } from 'node:path'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  buildWiki, buildMap, rankDiff, coverageReport, humanSize, ENGINE_VERSION, detectWikiDir,
} from '../lib/engine.js'

const HERE = dirname(fileURLToPath(import.meta.url))

function usage() {
  return [
    'repowiki v' + ENGINE_VERSION + ' —— 确定性代码库 wiki 引擎',
    '',
    '用法：',
    '  repowiki scan <项目根> [--out DIR] [--json]    生成 wiki（pages/tree/status/data.js）',
    '  repowiki map <项目根> [--format json|md] [--top N]   符号索引 + 依赖图 + PageRank',
    '  repowiki diff <项目根> [range] [--json]        按改动量×被依赖度排 review 顺序',
    '  repowiki coverage <项目根> [--json]            诚实覆盖报告',
    '  repowiki serve [--port N] [--dir WIKI_DIR]     本地查看器',
    '',
    '约定：',
    '  · 只读项目目录，写只写 --out（默认 <项目根>/../repowiki-out）',
    '  · 不做 AST、不联网、不调模型；推不出来的东西写在 coverage 的 limits 里',
  ].join('\n')
}

function parseArgs(argv) {
  const positional = []
  const flags = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token.startsWith('--')) {
      const name = token.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) {
        flags[name] = true
      } else {
        flags[name] = next
        i += 1
      }
    } else {
      positional.push(token)
    }
  }
  return { positional, flags }
}

function mdMapReport(map, top) {
  const lines = []
  lines.push('# 符号与依赖地图', '')
  lines.push('项目：`' + map.projectDir + '`', '')
  lines.push('## 规模', '')
  lines.push('| 指标 | 值 |', '|---|---|')
  lines.push('| 扫描文件 | ' + map.filesScanned + ' |')
  lines.push('| 源码文件 | ' + map.sourceFiles + ' |')
  lines.push('| 符号声明 | ' + map.symbols.length + ' |')
  lines.push('| 跨文件引用 | ' + map.edges.length + ' |')
  lines.push('')
  lines.push('## 阅读顺序（PageRank 前 ' + top + '）', '')
  for (const [i, row] of map.ranking.slice(0, top).entries()) {
    lines.push('- ' + (i + 1) + '. `' + row.file + '` — score ' + row.score + '，被引用 ' + (map.inbound.get(row.file) || 0) + ' 次')
  }
  if (!map.ranking.length) lines.push('（没有解析到依赖边）')
  lines.push('')
  lines.push('## 枢纽文件（按被引用次数）', '')
  const hubs = [...map.inbound.entries()].sort((a, b) => b[1] - a[1]).slice(0, top)
  if (hubs.length) {
    lines.push('| 文件 | 被引用 |', '|---|---|')
    for (const [file, count] of hubs) lines.push('| `' + file + '` | ' + count + ' |')
  } else {
    lines.push('（无）')
  }
  lines.push('')
  lines.push('> ' + map.note)
  return lines.join('\n')
}

function mdDiffReport(report, top) {
  const lines = []
  lines.push('# Review 顺序（按改动量 × 被依赖度）', '')
  lines.push('范围：`' + report.range + '`，改动文件 ' + report.filesChanged + ' 个，+' + report.totalAdded + ' / -' + report.totalDeleted, '')
  lines.push('| # | 文件 | + | - | 被引用 | 权重 |', '|---|---|---|---|---|---|')
  for (const [i, row] of report.files.slice(0, top).entries()) {
    lines.push('| ' + (i + 1) + ' | `' + row.file + '` | ' + row.added + ' | ' + row.deleted + ' | ' + row.fanIn + ' | ' + row.weight + ' |')
  }
  if (!report.files.length) lines.push('| — | （该范围内没有已跟踪文件的改动） | 0 | 0 | 0 | 0 |')
  if (report.untracked.length) {
    lines.push('', '## 未跟踪的新增文件', '')
    for (const file of report.untracked.slice(0, top)) lines.push('- `' + file + '`')
    if (report.untracked.length > top) lines.push('- … 另有 ' + (report.untracked.length - top) + ' 个')
  }
  lines.push('', '> 权重 = 改动行数 × (1 + 被引用数 × 0.35) + PageRank × 400。')
  lines.push('> 先看第 1 行：改动大、又被很多文件依赖，读漏的代价最高。')
  return lines.join('\n')
}

function mdCoverageReport(report) {
  const lines = []
  lines.push('# 覆盖报告', '')
  lines.push('项目：`' + report.projectDir + '`', '')
  lines.push('| 指标 | 值 |', '|---|---|')
  lines.push('| 扫描文件 | ' + report.filesScanned + ' |')
  lines.push('| 源码文件 | ' + report.sourceFiles + ' |')
  lines.push('| 源码体积 | ' + humanSize(report.sourceBytes) + ' |')
  lines.push('| 是否触顶 | ' + (report.truncated ? '是' : '否') + ' |')
  lines.push('| git HEAD | ' + (report.head || '（非 git 仓库）') + ' |')
  lines.push('')
  lines.push('## 按扩展名', '')
  lines.push('| 扩展名 | 文件数 | 体积 |', '|---|---|---|')
  for (const [ext, row] of report.byExt.slice(0, 30)) lines.push('| `' + ext + '` | ' + row.count + ' | ' + humanSize(row.bytes) + ' |')
  lines.push('')
  lines.push('## 跳过的路径', '')
  if (report.skipped.length) {
    lines.push('| 路径 | 原因 |', '|---|---|')
    for (const row of report.skipped.slice(0, 60)) lines.push('| `' + row.rel + '` | ' + row.reason + ' |')
  } else {
    lines.push('（没有跳过）')
  }
  lines.push('', '## 推不出来的东西', '')
  for (const line of report.limits) lines.push('- ' + line)
  return lines.join('\n')
}

function main(argv) {
  const command = argv[0]
  const { positional, flags } = parseArgs(argv.slice(1))

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(usage() + '\n')
    return 0
  }
  if (command === 'version' || command === '--version' || command === '-v') {
    process.stdout.write(ENGINE_VERSION + '\n')
    return 0
  }

  if (command === 'scan') {
    const project = resolve(positional[0] || '.')
    if (!existsSync(project)) {
      process.stderr.write('项目目录不存在：' + project + '\n')
      return 2
    }
    const out = resolve(flags.out ? String(flags.out) : join(dirname(project), 'repowiki-out'))
    const log = (line) => process.stdout.write(line + '\n')
    const result = buildWiki(project, out, {}, log)
    if (flags.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    else process.stdout.write('输出目录：' + result.outDir + '\n页数：' + result.pages.length + ' 耗时 ' + result.ms + ' ms\n')
    return 0
  }

  if (command === 'map') {
    const project = resolve(positional[0] || '.')
    const map = buildMap(project)
    const top = Number(flags.top) || 30
    if (flags.format === 'json') {
      process.stdout.write(JSON.stringify({
        projectDir: map.projectDir, filesScanned: map.filesScanned, sourceFiles: map.sourceFiles,
        symbols: map.symbols, edges: map.edges,
        ranking: map.ranking.slice(0, top),
        inbound: [...map.inbound.entries()].sort((a, b) => b[1] - a[1]).slice(0, top),
        skipped: map.skipped, note: map.note,
      }, null, 2) + '\n')
    } else {
      process.stdout.write(mdMapReport(map, top) + '\n')
    }
    return 0
  }

  if (command === 'diff') {
    const project = resolve(positional[0] || '.')
    const range = positional[1] || flags.range || 'HEAD'
    const report = rankDiff(project, String(range))
    const top = Number(flags.top) || 40
    if (flags.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n')
    else process.stdout.write(mdDiffReport(report, top) + '\n')
    return 0
  }

  if (command === 'coverage') {
    const project = resolve(positional[0] || '.')
    const report = coverageReport(project)
    if (flags.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n')
    else process.stdout.write(mdCoverageReport(report) + '\n')
    return 0
  }

  if (command === 'serve') {
    const port = Number(flags.port) || 34572
    const dir = resolve(flags.dir ? String(flags.dir) : process.cwd())
    process.stdout.write('查看器：http://127.0.0.1:' + port + '/  →  ' + dir + '\n')
    process.stdout.write('（本命令只打印地址；常驻服务由 DSH 插件 @dsh-external/dsh-repowiki 提供）\n')
    return 0
  }

  process.stderr.write('未知命令：' + command + '\n\n' + usage() + '\n')
  return 2
}

const code = main(process.argv.slice(2))
process.exitCode = code
