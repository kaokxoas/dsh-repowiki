/**
 * @dsh-external/dsh-repowiki —— Host 半身
 * ---------------------------------------------------------------------------
 * 一个常驻 HTTP 服务 + 四个模型可调工具，全部包装 lib/engine.js 的确定性能力。
 *
 *   GET  /@dsh-external/dsh-repowiki/api/health        健康检查
 *   GET  /@dsh-external/dsh-repowiki/api/state         当前 wiki 目录与项目状态
 *   GET  /@dsh-external/dsh-repowiki/api/wiki          data.js（阅读器直接消费）
 *   GET  /@dsh-external/dsh-repowiki/api/pages/<id>    单页 markdown
 *   POST /@dsh-external/dsh-repowiki/api/scan          { project, out? } 触发生成
 *   POST /@dsh-external/dsh-repowiki/api/coverage      { project } 覆盖报告
 *   POST /@dsh-external/dsh-repowiki/api/map           { project, top? } 符号与依赖
 *   POST /@dsh-external/dsh-repowiki/api/diff          { project, range? } review 顺序
 *
 * 工具：repowiki_scan / repowiki_map / repowiki_diff / repowiki_coverage
 *
 * 零第三方依赖；不联网；只在 --out 指定的目录里写盘。
 */
import { createServer } from 'node:http'
import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, resolve, extname, sep, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildWiki, buildMap, rankDiff, coverageReport, detectWikiDir, humanSize, ENGINE_VERSION,
} from './engine.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_DIR = resolve(HERE, '..')
const PREFIX = '/@dsh-external/dsh-repowiki/api'

export const inject = ['webServer', 'tools']

const DEFAULT_WIKI_DIR = 'D:/WORK/repowiki-out'
const DEFAULT_PROJECT = 'D:/WORK/MINISO/project'
const PORT = 34572

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
}

let state = {
  wikiDir: DEFAULT_WIKI_DIR,
  project: DEFAULT_PROJECT,
  lastScan: null,
  scanning: false,
  log: [],
}

function send(res, code, type, body) {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(body)
}

function sendJson(res, code, value) {
  send(res, code, 'application/json; charset=utf-8', JSON.stringify(value))
}

function pushLog(line) {
  state.log.push({ at: new Date().toISOString(), line: String(line) })
  if (state.log.length > 200) state.log.splice(0, state.log.length - 200)
}

function readWikiBundle(dir) {
  const dataFile = join(dir, 'data.js')
  if (!existsSync(dataFile)) return null
  try {
    const raw = readFileSync(dataFile, 'utf8')
    const prefix = raw.indexOf('window.WIKI=')
    const json = prefix >= 0 ? raw.slice(prefix + 'window.WIKI='.length).replace(/;\s*$/, '') : raw
    return JSON.parse(json)
  } catch (error) {
    return { error: 'data.js 解析失败：' + String(error && error.message ? error.message : error) }
  }
}

async function guardThrottle(ms) {
  if (state.scanning) return false
  state.scanning = true
  const timer = setTimeout(() => { state.scanning = false }, ms)
  timer.unref?.()
  return true
}

/* ------------------------------------------------------------------ 工具 */

function textResult(value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
}

function installTools(ctx) {
  const disposers = []

  disposers.push(ctx.tools.register({
    name: 'repowiki_scan',
    description:
      '扫描一个项目目录，确定性地生成一套 wiki（pages/*.md + tree.json + status.json + data.js）。' +
      '不调模型、不联网，产出可直接被 repo-wiki 查看器打开。返回页数与输出目录。',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: '项目根目录绝对路径' },
        out: { type: 'string', description: '输出目录，省略则用 <项目父目录>/repowiki-out' },
      },
      required: ['project'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { report: { type: 'string' } }, required: ['report'], additionalProperties: false },
      render(_args, value) { return textResult(value.report) },
    },
    execute(args) {
      const project = resolve(String(args.project))
      const out = resolve(args.out ? String(args.out) : join(dirname(project), 'repowiki-out'))
      if (!existsSync(project)) return Promise.resolve({ report: '项目目录不存在：' + project })
      const lines = []
      try {
        const result = buildWiki(project, out, {}, (line) => lines.push(line))
        state.wikiDir = out
        state.project = project
        state.lastScan = { at: new Date().toISOString(), outDir: result.outDir, pages: result.pages.length, ms: result.ms }
        return Promise.resolve({
          report: [
            '已生成：' + result.outDir,
            '页数：' + result.pages.length + '（' + result.pages.join(', ') + '）',
            '耗时：' + result.ms + ' ms',
            '过程：',
            ...lines.map((line) => '  ' + line),
          ].join('\n'),
        })
      } catch (error) {
        return Promise.resolve({ report: '生成失败：' + String(error && error.message ? error.message : error) })
      }
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'repowiki_map',
    description:
      '给出项目的符号索引、跨文件依赖图与 PageRank 阅读顺序。喂给 scout 子 agent 用最合适：' +
      '它回答「从哪读起」和「哪些是枢纽文件」。文本级抽取，不做 AST。',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: '项目根目录绝对路径' },
        top: { type: 'number', description: '返回前多少个，默认 30' },
      },
      required: ['project'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { report: { type: 'string' } }, required: ['report'], additionalProperties: false },
      render(_args, value) { return textResult(value.report) },
    },
    execute(args) {
      const project = resolve(String(args.project))
      const top = Number(args.top) || 30
      try {
        const map = buildMap(project)
        const lines = []
        lines.push('项目：' + map.projectDir)
        lines.push('扫描 ' + map.filesScanned + ' 文件 / 源码 ' + map.sourceFiles + ' / 符号 ' + map.symbols.length + ' / 依赖边 ' + map.edges.length)
        lines.push('')
        lines.push('阅读顺序（PageRank 前 ' + top + '）：')
        for (const [i, row] of map.ranking.slice(0, top).entries()) {
          lines.push('  ' + (i + 1) + '. ' + row.file + '  score=' + row.score + '  fanIn=' + (map.inbound.get(row.file) || 0))
        }
        if (!map.ranking.length) lines.push('  （没有解析到依赖边）')
        lines.push('')
        lines.push(map.note)
        return Promise.resolve({ report: lines.join('\n') })
      } catch (error) {
        return Promise.resolve({ report: '分析失败：' + String(error && error.message ? error.message : error) })
      }
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'repowiki_diff',
    description:
      '按「改动行数 × 被依赖度 × PageRank」给一个 git 区间的改动文件排 review 顺序。' +
      '先读第 1 行：改动大又被很多文件依赖，读漏代价最高。',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: '项目根目录绝对路径' },
        range: { type: 'string', description: 'git 区间，如 main...HEAD，默认 HEAD' },
        top: { type: 'number', description: '返回前多少个，默认 40' },
      },
      required: ['project'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { report: { type: 'string' } }, required: ['report'], additionalProperties: false },
      render(_args, value) { return textResult(value.report) },
    },
    execute(args) {
      const project = resolve(String(args.project))
      const top = Number(args.top) || 40
      try {
        const report = rankDiff(project, args.range ? String(args.range) : 'HEAD')
        const lines = []
        lines.push('范围：' + report.range + '，改动 ' + report.filesChanged + ' 个文件，+' + report.totalAdded + ' / -' + report.totalDeleted)
        lines.push('')
        lines.push('序  改动  被引用  权重      文件')
        for (const [i, row] of report.files.slice(0, top).entries()) {
          lines.push(String(i + 1).padStart(2) + '  +' + row.added + '/-' + row.deleted + '  ' + row.fanIn + '  ' + row.weight + '  ' + row.file)
        }
        if (!report.files.length) lines.push('（该范围内没有已跟踪文件的改动）')
        if (report.untracked.length) {
          lines.push('')
          lines.push('未跟踪新增（' + report.untracked.length + ' 个）：')
          for (const file of report.untracked.slice(0, top)) lines.push('  ' + file)
        }
        return Promise.resolve({ report: lines.join('\n') })
      } catch (error) {
        return Promise.resolve({ report: '排序失败：' + String(error && error.message ? error.message : error) })
      }
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'repowiki_coverage',
    description:
      '诚实覆盖报告：这个项目扫了多少文件、多少源码、跳过了哪些路径、哪些东西静态分析推不出来。' +
      '不相信任何 wiki 结论时先跑这个。',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string', description: '项目根目录绝对路径' },
      },
      required: ['project'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { report: { type: 'string' } }, required: ['report'], additionalProperties: false },
      render(_args, value) { return textResult(value.report) },
    },
    execute(args) {
      const project = resolve(String(args.project))
      try {
        const report = coverageReport(project)
        const lines = []
        lines.push('项目：' + report.projectDir)
        lines.push('文件 ' + report.filesScanned + ' / 源码 ' + report.sourceFiles + ' / 源码体积 ' + humanSize(report.sourceBytes))
        lines.push('git HEAD：' + (report.head || '（非 git 仓库）'))
        lines.push('触顶：' + (report.truncated ? '是' : '否'))
        lines.push('')
        lines.push('按扩展名（前 15）：')
        for (const [ext, row] of report.byExt.slice(0, 15)) lines.push('  ' + ext + '  ' + row.count + ' 个  ' + humanSize(row.bytes))
        lines.push('')
        lines.push('跳过的路径（前 30）：')
        if (report.skipped.length) for (const row of report.skipped.slice(0, 30)) lines.push('  ' + row.rel + '  —  ' + row.reason)
        else lines.push('  （没有跳过）')
        lines.push('')
        lines.push('推不出来的东西：')
        for (const line of report.limits) lines.push('  · ' + line)
        return Promise.resolve({ report: lines.join('\n') })
      } catch (error) {
        return Promise.resolve({ report: '覆盖报告失败：' + String(error && error.message ? error.message : error) })
      }
    },
  }))

  return disposers
}

/* ------------------------------------------------------------------ 路由 */

function buildRoutes(ctx) {
  const route = (path, handler) => ({ kind: 'exact', path: PREFIX + path, handler })

  return [
    route('/health', (req, res) => send(res, 200, 'text/plain; charset=utf-8', 'ok')),

    route('/state', (req, res) => sendJson(res, 200, {
      engine: ENGINE_VERSION,
      wikiDir: state.wikiDir,
      project: state.project,
      wikiExists: Boolean(detectWikiDir(state.wikiDir)),
      scanning: state.scanning,
      lastScan: state.lastScan,
      log: state.log.slice(-20),
    })),

    route('/wiki', (req, res) => {
      const bundle = readWikiBundle(state.wikiDir)
      if (!bundle) return sendJson(res, 404, { error: '还没有生成 wiki：' + state.wikiDir })
      return sendJson(res, 200, bundle)
    }),

    route('/pages', (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1')
      const id = url.searchParams.get('id') || ''
      if (!/^[A-Za-z0-9._-]+$/.test(id)) return sendJson(res, 400, { error: '非法的页 id' })
      const file = join(state.wikiDir, 'pages', id + '.md')
      if (!existsSync(file)) return sendJson(res, 404, { error: '没有这一页：' + id })
      return send(res, 200, MIME['.md'], readFileSync(file, 'utf8'))
    }),

    route('/coverage', (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1')
      const project = resolve(url.searchParams.get('project') || state.project)
      try {
        const report = coverageReport(project)
        return sendJson(res, 200, { ...report, byExt: report.byExt.slice(0, 40), skipped: report.skipped.slice(0, 120) })
      } catch (error) {
        return sendJson(res, 500, { error: String(error && error.message ? error.message : error) })
      }
    }),

    route('/map', (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1')
      const project = resolve(url.searchParams.get('project') || state.project)
      const top = Number(url.searchParams.get('top')) || 30
      try {
        const map = buildMap(project)
        return sendJson(res, 200, {
          projectDir: map.projectDir,
          filesScanned: map.filesScanned,
          sourceFiles: map.sourceFiles,
          symbolCount: map.symbols.length,
          edgeCount: map.edges.length,
          ranking: map.ranking.slice(0, top),
          inbound: [...map.inbound.entries()].sort((a, b) => b[1] - a[1]).slice(0, top),
          note: map.note,
        })
      } catch (error) {
        return sendJson(res, 500, { error: String(error && error.message ? error.message : error) })
      }
    }),

    route('/diff', (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1')
      const project = resolve(url.searchParams.get('project') || state.project)
      const range = url.searchParams.get('range') || 'HEAD'
      try {
        return sendJson(res, 200, rankDiff(project, range))
      } catch (error) {
        return sendJson(res, 500, { error: String(error && error.message ? error.message : error) })
      }
    }),

    route('/scan', (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { error: '只接受 POST' })
      let body = ''
      req.on('data', (chunk) => { body += chunk; if (body.length > 1 << 20) req.destroy() })
      req.on('end', () => {
        let payload = {}
        try {
          payload = body ? JSON.parse(body) : {}
        } catch {
          return sendJson(res, 400, { error: '请求体不是合法 JSON' })
        }
        const project = resolve(payload.project || state.project)
        const out = resolve(payload.out || join(dirname(project), 'repowiki-out'))
        if (!existsSync(project)) return sendJson(res, 400, { error: '项目目录不存在：' + project })
        if (state.scanning) return sendJson(res, 409, { error: '已有一次生成在进行中' })
        state.scanning = true
        state.log = []
        const lines = []
        try {
          const result = buildWiki(project, out, {}, (line) => { lines.push(line); pushLog(line) })
          state.wikiDir = out
          state.project = project
          state.lastScan = { at: new Date().toISOString(), outDir: result.outDir, pages: result.pages.length, ms: result.ms }
          state.scanning = false
          return sendJson(res, 200, { ok: true, ...result, lines })
        } catch (error) {
          state.scanning = false
          const message = String(error && error.message ? error.message : error)
          pushLog('失败：' + message)
          return sendJson(res, 500, { error: message, lines })
        }
      })
    }),
  ]
}

/* ------------------------------------------------------------------ 入口 */

export function apply(ctx, config = {}) {
  if (config.wikiDir) state.wikiDir = resolve(String(config.wikiDir))
  else if (process.env.REPOWIKI_DIR) state.wikiDir = resolve(process.env.REPOWIKI_DIR)
  if (config.project) state.project = resolve(String(config.project))
  else if (process.env.REPOWIKI_PROJECT) state.project = resolve(process.env.REPOWIKI_PROJECT)
  const port = Number(config.port || process.env.REPOWIKI_PORT || PORT)

  try {
    mkdirSync(state.wikiDir, { recursive: true })
  } catch { /* 目录可能建不了，扫描时再报 */ }

  const toolDisposers = installTools(ctx)

  ctx.effect(() => {
    const routes = buildRoutes(ctx)
    const disposers = routes.map((item) => ctx.webServer.register(item))
    const server = createServer((req, res) => {
      const path = (req.url || '/').split('?')[0]
      if (!path.startsWith(PREFIX)) return send(res, 404, 'text/plain; charset=utf-8', 'not found')
      const handler = routes.find((item) => item.path === path)
      if (!handler) return send(res, 404, 'text/plain; charset=utf-8', 'no route')
      try {
        return handler.handler(req, res)
      } catch (error) {
        return sendJson(res, 500, { error: String(error && error.message ? error.message : error) })
      }
    })
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      if (ctx.logger && ctx.logger.info) ctx.logger.info('dsh-repowiki ready: ' + state.wikiDir + ' (port ' + port + ')')
    }
    server.on('error', () => finish())
    try {
      server.listen(port, '127.0.0.1', () => {
        const timer = setTimeout(finish, 4000)
        timer.unref?.()
      })
    } catch {
      finish()
    }
    return () => {
      for (const dispose of disposers) {
        try { dispose() } catch { /* ignore */ }
      }
      try { server.close() } catch { /* ignore */ }
    }
  })

  return () => {
    for (const dispose of toolDisposers) {
      try { dispose() } catch { /* ignore */ }
    }
  }
}
