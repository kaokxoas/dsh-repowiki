/**
 * dsh-repowiki —— 确定性 wiki 引擎（零第三方依赖 / 不调用任何模型）
 * ---------------------------------------------------------------------------
 *   scan     扫描项目 → pages/*.md + tree.json + status.json + data.js
 *   map      符号索引 + import 图 + PageRank 阅读排序
 *   diff     改动量 × 被依赖度 → review 顺序
 *   coverage 诚实覆盖报告：扫了什么、跳了什么、推不出什么
 *
 * 只输出本站渲染器支持的 Markdown 子集：标题 / 一层列表 / 竖线表格 / 代码块 / 引用。
 */
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, rmSync,
} from 'node:fs'
import { join, dirname, resolve, extname, basename } from 'node:path'
import { execFileSync } from 'node:child_process'

export const ENGINE_VERSION = '1.0.0'

const SKIP_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'target', 'build', 'dist', 'out',
  '.idea', '.vscode', '.vs', '__pycache__', '.next', '.nuxt', '.venv', 'venv', 'env',
  'vendor', 'coverage', '.gradle', '.mvn', '.pytest_cache', '.mypy_cache',
  'bower_components', '.cache', '.turbo', '.parcel-cache', '.terraform', 'Pods', 'DerivedData',
])

const LANG_BY_EXT = {
  '.java': 'Java', '.kt': 'Kotlin', '.scala': 'Scala', '.groovy': 'Groovy',
  '.js': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript', '.jsx': 'JavaScript',
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.mts': 'TypeScript', '.cts': 'TypeScript',
  '.vue': 'Vue', '.svelte': 'Svelte', '.py': 'Python', '.rb': 'Ruby', '.php': 'PHP',
  '.go': 'Go', '.rs': 'Rust', '.c': 'C', '.h': 'C', '.cpp': 'C++', '.cc': 'C++',
  '.hpp': 'C++', '.cs': 'C#', '.swift': 'Swift', '.m': 'Objective-C', '.dart': 'Dart',
  '.sql': 'SQL', '.sh': 'Shell', '.bash': 'Shell', '.ps1': 'PowerShell', '.bat': 'Batch',
  '.yml': 'YAML', '.yaml': 'YAML', '.json': 'JSON', '.xml': 'XML', '.toml': 'TOML',
  '.md': 'Markdown', '.html': 'HTML', '.css': 'CSS', '.scss': 'SCSS', '.less': 'LESS',
}

const SOURCE_EXTS = new Set([
  '.java', '.kt', '.scala', '.groovy', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx',
  '.vue', '.svelte', '.py', '.rb', '.php', '.go', '.rs', '.c', '.h', '.cpp', '.cc',
  '.hpp', '.cs', '.swift', '.dart',
])

const MANIFEST_NAMES = [
  'package.json', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle',
  'requirements.txt', 'pyproject.toml', 'setup.py', 'go.mod', 'Cargo.toml',
  'composer.json', 'Gemfile', 'pubspec.yaml', 'CMakeLists.txt', 'Makefile',
  'Dockerfile', 'docker-compose.yml', 'docker-compose.yaml',
]

const MAX_FILES = 40000
const MAX_READ_BYTES = 512 * 1024

const toPosix = (p) => String(p).split('\\').join('/')

export function humanSize(bytes) {
  const n = Number(bytes) || 0
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB'
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB'
}

function table(header, rows) {
  if (!rows || !rows.length) return '（无数据）'
  const clean = (v) => String(v === undefined || v === null ? '' : v).replace(/[|\r\n]/g, '/').trim()
  const lines = ['| ' + header.map(clean).join(' | ') + ' |', '|' + header.map(() => '---').join('|') + '|']
  for (const row of rows) lines.push('| ' + row.map(clean).join(' | ') + ' |')
  return lines.join('\n')
}

function readTextSafe(file) {
  try {
    const st = statSync(file)
    if (!st.isFile() || st.size > MAX_READ_BYTES) return null
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

function git(projectDir, args, timeout = 15000) {
  try {
    return execFileSync('git', ['-C', projectDir, ...args], {
      encoding: 'utf8', timeout, maxBuffer: 1 << 26,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }).trim()
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ 扫描 */

export function walkProject(projectDir, options = {}) {
  const root = resolve(projectDir)
  const files = []
  const skipped = []
  const maxFiles = options.maxFiles || MAX_FILES
  let visited = 0

  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      skipped.push({ rel: toPosix(dir.slice(root.length + 1)) || '.', reason: '读不到：' + error.code })
      continue
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        skipped.push({ rel: toPosix(abs.slice(root.length + 1)), reason: '符号链接（不跟随）' })
        continue
      }
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) {
          skipped.push({ rel: toPosix(abs.slice(root.length + 1)), reason: '构建产物/依赖目录' })
          continue
        }
        if (entry.name.startsWith('.')) {
          skipped.push({ rel: toPosix(abs.slice(root.length + 1)), reason: '隐藏目录' })
          continue
        }
        stack.push(abs)
        continue
      }
      if (!entry.isFile()) continue
      if (entry.name.startsWith('.') && entry.name !== '.gitignore') {
        skipped.push({ rel: toPosix(abs.slice(root.length + 1)), reason: '隐藏文件' })
        continue
      }
      if (++visited > maxFiles) {
        skipped.push({ rel: '.', reason: '达到文件上限 ' + maxFiles })
        return { files, skipped, truncated: true }
      }
      let st
      try {
        st = statSync(abs)
      } catch {
        skipped.push({ rel: toPosix(abs.slice(root.length + 1)), reason: 'stat 失败' })
        continue
      }
      files.push({ rel: toPosix(abs.slice(root.length + 1)), abs, size: st.size, ext: extname(entry.name).toLowerCase() })
    }
  }
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  return { files, skipped, truncated: false }
}

/* ------------------------------------------------------------------ git */

export function gitSummary(projectDir, options = {}) {
  const commitLimit = options.commitLimit || 300
  if (!existsSync(join(projectDir, '.git'))) return null
  const head = git(projectDir, ['rev-parse', 'HEAD'])
  if (!head) return null
  const branch = git(projectDir, ['rev-parse', '--abbrev-ref', 'HEAD']) || '—'
  const count = Number(git(projectDir, ['rev-list', '--count', 'HEAD']) || 0)
  const raw = git(projectDir, ['log', '-n', String(commitLimit), '--date=short', '--pretty=format:%H\x1f%h\x1f%an\x1f%ad\x1f%s']) || ''
  const commits = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    const p = line.split('\x1f')
    if (p.length < 5) continue
    commits.push({ hash: p[1], full: p[0], author: p[2], date: p[3], subject: p[4] })
  }
  const firstDate = git(projectDir, ['log', '--reverse', '--date=short', '--pretty=format:%ad']) || ''
  const authorCounts = new Map()
  for (const c of commits) authorCounts.set(c.author, (authorCounts.get(c.author) || 0) + 1)
  return {
    head: head.slice(0, 12), fullHead: head, branch, commitCount: count, commits, authorCounts,
    churn: gitChurn(projectDir, commitLimit),
    firstDate: firstDate ? firstDate.split('\n')[0] : '',
    latest: commits[0] || null,
  }
}

const CHURN_CACHE = new Map()
function gitChurn(projectDir, limit) {
  const key = projectDir + '::' + limit
  if (CHURN_CACHE.has(key)) return CHURN_CACHE.get(key)
  const raw = git(projectDir, ['log', '-n', String(limit), '--name-only', '--pretty=format:']) || ''
  const counter = new Map()
  for (const line of raw.split('\n')) {
    const rel = line.trim()
    if (!rel) continue
    counter.set(rel, (counter.get(rel) || 0) + 1)
  }
  CHURN_CACHE.set(key, counter)
  return counter
}

/* ------------------------------------------------------------------ 符号与依赖 */

const SYMBOL_RULES = [
  { ext: ['.java', '.kt', '.scala', '.groovy'], re: /^\s*(?:public|private|protected|internal)?\s*(?:static\s+)?(?:final\s+)?(?:abstract\s+)?(class|interface|enum|record|object)\s+([A-Za-z_$][\w$]*)/gm, kindFrom: 1, nameFrom: 2 },
  { ext: ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.vue', '.svelte'], re: /^\s*export\s+(?:default\s+)?(?:async\s+)?(class|function|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm, kindFrom: 1, nameFrom: 2 },
  { ext: ['.py'], re: /^(class|def)\s+([A-Za-z_]\w*)/gm, kindFrom: 1, nameFrom: 2 },
  { ext: ['.go'], re: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm, kind: 'func', nameFrom: 1 },
  { ext: ['.rb'], re: /^\s*(class|module|def)\s+([A-Za-z_]\w*)/gm, kindFrom: 1, nameFrom: 2 },
  { ext: ['.php'], re: /^\s*(?:abstract\s+|final\s+)?(class|interface|trait|function)\s+([A-Za-z_]\w*)/gm, kindFrom: 1, nameFrom: 2 },
  { ext: ['.cs'], re: /^\s*(?:public|private|protected|internal)?\s*(?:static\s+)?(?:sealed\s+)?(class|interface|enum|struct|record)\s+([A-Za-z_]\w*)/gm, kindFrom: 1, nameFrom: 2 },
]

const IMPORT_RULES = [
  { ext: ['.java', '.kt', '.scala', '.groovy'], re: /^\s*import\s+(?:static\s+)?([\w.]+)\s*;?/gm, style: 'fqcn' },
  { ext: ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.vue', '.svelte'], re: /(?:from\s+|require\s*\(\s*)['"]([^'"]+)['"]/gm, style: 'path' },
  { ext: ['.py'], re: /^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm, style: 'module' },
]

export function buildMap(projectDir, options = {}) {
  const root = resolve(projectDir)
  const walked = options.files
    ? { files: options.files, skipped: options.skipped || [], truncated: Boolean(options.truncated) }
    : walkProject(root, options)
  const sourceFiles = walked.files.filter((f) => SOURCE_EXTS.has(f.ext))

  const symbols = []
  const edges = []
  const byRel = new Map(walked.files.map((f) => [f.rel, f]))
  const packageIndex = new Map()
  const stemIndex = new Map()

  for (const file of sourceFiles) {
    const stem = basename(file.rel, extname(file.rel))
    if (!stemIndex.has(stem)) stemIndex.set(stem, [])
    stemIndex.get(stem).push(file.rel)
    if (file.ext === '.java' || file.ext === '.kt') {
      // Maven / Gradle 目录结构会多出 src/main/java 这类源码根前缀，而 import 写的是
      // 纯包名（com.topdata.x.Y）。早先直接把整条目录当包名，6909 个 Java 文件一条
      // 边都没有（实测 edges 全来自 .py）。这里先截掉源码根，再用剩下的目录当包名。
      const dirPath = toPosix(dirname(file.rel))
      const packageDir = stripSourceRoot(dirPath)
      const prefix = packageDir === '' ? '' : packageDir.split('/').filter(Boolean).join('.') + '.'
      packageIndex.set(prefix + stem, file.rel)
    }
  }

  for (const file of sourceFiles) {
    const text = readTextSafe(file.abs)
    if (!text) continue
    for (const rule of SYMBOL_RULES) {
      if (!rule.ext.includes(file.ext)) continue
      rule.re.lastIndex = 0
      let m
      let guard = 0
      while ((m = rule.re.exec(text)) !== null && guard++ < 5000) {
        const name = m[rule.nameFrom]
        if (!name) continue
        const kind = rule.kind || (m[rule.kindFrom] ? String(m[rule.kindFrom]).toLowerCase() : 'symbol')
        symbols.push({ file: file.rel, name, kind, line: text.slice(0, m.index).split('\n').length })
      }
    }
    for (const rule of IMPORT_RULES) {
      if (!rule.ext.includes(file.ext)) continue
      rule.re.lastIndex = 0
      let m
      let guard = 0
      while ((m = rule.re.exec(text)) !== null && guard++ < 3000) {
        const spec = m[1] || m[2]
        if (!spec) continue
        const target = resolveImport(file.rel, spec, rule.style, byRel, packageIndex, stemIndex)
        if (target && target !== file.rel) edges.push({ from: file.rel, to: target, spec })
      }
    }
  }

  const inbound = new Map()
  const outbound = new Map()
  for (const e of edges) {
    inbound.set(e.to, (inbound.get(e.to) || 0) + 1)
    outbound.set(e.from, (outbound.get(e.from) || 0) + 1)
  }

  return {
    projectDir: root, filesScanned: walked.files.length, sourceFiles: sourceFiles.length,
    skipped: walked.skipped, truncated: walked.truncated,
    symbols, edges, inbound, outbound,
    ranking: pageRank(walked.files.map((f) => f.rel), edges),
    note: '文本级抽取：正则扫声明行与 import 行，不做 AST。动态 require、DI 注入、通配 import、反射调用都不可见。',
  }
}

/**
 * 截掉 Java/Kotlin 的源码根前缀，只留真正的包路径。
 * 覆盖 Maven/Gradle 的 src/{main,test}/{java,kotlin}，以及 Android 的 src/{main,debug}/java。
 */
const SOURCE_ROOT_RE = /(?:^|\/)(?:src|source)\/(?:[A-Za-z0-9_-]+\/)*(?:java|kotlin|scala|groovy)\//
function stripSourceRoot(dirPath) {
  const p = toPosix(dirPath)
  const m = SOURCE_ROOT_RE.exec(p + '/')
  if (!m) return p
  const cut = m.index + m[0].length
  const rest = p.slice(cut)
  return rest
}

function resolveImport(fromRel, spec, style, byRel, packageIndex, stemIndex) {  if (style === 'fqcn') {
    if (packageIndex.has(spec)) return packageIndex.get(spec)
    const parts = spec.split('.')
    for (let i = parts.length; i > 0; i -= 1) {
      const key = parts.slice(0, i).join('.')
      if (packageIndex.has(key)) return packageIndex.get(key)
    }
    return null
  }
  if (style === 'module') {
    if (packageIndex.has(spec)) return packageIndex.get(spec)
    const tail = spec.split('.').pop()
    const hit = stemIndex.get(tail)
    return hit && hit.length ? hit[0] : null
  }
  if (!spec.startsWith('.') && !spec.startsWith('/')) return null
  const baseDir = dirname(fromRel)
  const joined = toPosix(resolve('/', baseDir, spec)).replace(/^\//, '')
  for (const c of [joined, joined + '.ts', joined + '.tsx', joined + '.js', joined + '.jsx', joined + '.mjs', joined + '/index.ts', joined + '/index.tsx', joined + '/index.js']) {
    if (byRel.has(c)) return c
  }
  return null
}

function pageRank(nodes, edges, iterations = 25, damping = 0.85) {
  const n = nodes.length || 1
  const rank = new Map(nodes.map((id) => [id, 1 / n]))
  const outs = new Map()
  for (const e of edges) {
    if (!outs.has(e.from)) outs.set(e.from, [])
    outs.get(e.from).push(e.to)
  }
  const base = (1 - damping) / n
  for (let i = 0; i < iterations; i += 1) {
    // 悬挂节点（无出边）的总权重先累加成一个标量，再一次性均分给所有节点。
    // 早先的写法是在节点循环里对每个悬挂节点再跑一遍全量节点，复杂度 O(n^2)：
    // 实测边缘为 0 时 n=2000 需要 4.3 秒，9570 个源码文件会把 scan 卡到分钟级。
    let dangling = 0
    for (const id of nodes) {
      const list = outs.get(id)
      if (!list || !list.length) dangling += rank.get(id)
    }
    const spread = (damping * dangling) / n
    const next = new Map(nodes.map((id) => [id, base + spread]))
    for (const id of nodes) {
      const list = outs.get(id)
      if (!list || !list.length) continue
      const share = rank.get(id) / list.length
      for (const to of list) if (next.has(to)) next.set(to, next.get(to) + damping * share)
    }
    for (const id of nodes) rank.set(id, next.get(id))
  }
  return [...rank.entries()].map(([file, score]) => ({ file, score: Number(score.toFixed(6)) })).sort((a, b) => b.score - a.score)
}

/* ------------------------------------------------------------------ diff */

export function rankDiff(projectDir, range, options = {}) {
  const root = resolve(projectDir)
  const numstat = git(root, ['diff', '--numstat', range || 'HEAD']) || ''
  const rows = []
  let totalAdded = 0
  let totalDeleted = 0
  for (const line of numstat.split('\n')) {
    const parts = line.split('\t')
    if (parts.length < 3) continue
    const added = Number(parts[0]) || 0
    const deleted = Number(parts[1]) || 0
    totalAdded += added
    totalDeleted += deleted
    rows.push({ file: toPosix(parts[2]), added, deleted, churn: added + deleted })
  }
  const untracked = (git(root, ['ls-files', '--others', '--exclude-standard']) || '')
    .split('\n').map((s) => s.trim()).filter(Boolean).map(toPosix)

  const map = options.map || buildMap(root)
  const rankByName = new Map(map.ranking.map((r, i) => [r.file, { score: r.score, order: i }]))
  for (const row of rows) {
    const meta = rankByName.get(row.file)
    row.fanIn = map.inbound.get(row.file) || 0
    row.rankScore = meta ? meta.score : 0
    row.rankOrder = meta ? meta.order : 999999
    row.weight = Number((row.churn * (1 + row.fanIn * 0.35) + row.rankScore * 400).toFixed(3))
  }
  rows.sort((a, b) => b.weight - a.weight)
  return { range: range || 'HEAD', files: rows, untracked, totalAdded, totalDeleted, filesChanged: rows.length }
}

/* ------------------------------------------------------------------ 覆盖报告 */

export function coverageReport(projectDir, options = {}) {
  const root = resolve(projectDir)
  const walked = options.files
    ? { files: options.files, skipped: options.skipped || [], truncated: Boolean(options.truncated) }
    : walkProject(root, options)
  const byExt = new Map()
  let sourceCount = 0
  let sourceBytes = 0
  for (const file of walked.files) {
    const ext = file.ext || '(无扩展名)'
    if (!byExt.has(ext)) byExt.set(ext, { count: 0, bytes: 0 })
    const row = byExt.get(ext)
    row.count += 1
    row.bytes += file.size
    if (SOURCE_EXTS.has(file.ext)) {
      sourceCount += 1
      sourceBytes += file.size
    }
  }
  const manifestHits = walked.files.filter((f) => MANIFEST_NAMES.includes(basename(f.rel))).map((f) => f.rel)
  const gitInfo = gitSummary(root, { commitLimit: 50 })
  return {
    projectDir: root, filesScanned: walked.files.length, truncated: walked.truncated,
    sourceFiles: sourceCount, sourceBytes,
    byExt: [...byExt.entries()].sort((a, b) => b[1].count - a[1].count),
    skipped: walked.skipped, manifests: manifestHits,
    hasGit: Boolean(gitInfo), head: gitInfo ? gitInfo.head : null, engine: ENGINE_VERSION,
    limits: [
      '只做静态文本分析：不看运行时行为、不看反射/动态加载/DI 容器注入。',
      '不做语义理解：页面文字由模板生成，不含「为什么这样设计」的判断。',
      '不验证结论：数字来自文件计数与 git 元数据；跑一次业务用例才能确认的行为不在此列。',
      '跳过隐藏目录、构建产物目录、符号链接；跳过清单逐条列在 skipped 里。',
    ],
  }
}

/* ------------------------------------------------------------------ 生成 wiki */

const MANIFEST = '.repowiki-manifest.json'

const SEARCH_WORDS = {
  overview: '速览 总览 从哪读起 阅读顺序 pagerank 入口 简介',
  structure: '目录 结构 模块 布局 文件夹',
  deps: '依赖 版本 脚本 npm gradle maven 构建',
  symbols: '符号 索引 类 方法 函数 接口 定义 import 引用',
  history: '历史 提交 commit 作者 时间 git',
  coverage: '覆盖 遗漏 跳过 可信度 限制 诚实',
  todos: '待办 todo fixme 技术债',
}

const TYPE_KIND_RE = /class|interface|enum|record|object|trait|struct|type/i

export function buildWiki(projectDir, outDir, options = {}, log = () => {}) {
  const root = resolve(projectDir)
  const out = resolve(outDir)
  if (!existsSync(root)) throw new Error('项目目录不存在：' + root)
  const began = Date.now()
  log('扫描 ' + root)

  const walked = walkProject(root, options)
  const coverage = coverageReport(root, { files: walked.files, skipped: walked.skipped, truncated: walked.truncated })
  const gitInfo = gitSummary(root, { commitLimit: 300 })
  const map = buildMap(root, { files: walked.files })

  log('文件 ' + walked.files.length + ' / 源码 ' + map.sourceFiles + ' / 符号 ' + map.symbols.length + ' / 依赖边 ' + map.edges.length)

  let pkg = null
  const pkgText = readTextSafe(join(root, 'package.json'))
  if (pkgText) {
    try {
      pkg = JSON.parse(pkgText)
    } catch {
      pkg = null
    }
  }
  const depRows = []
  if (pkg) {
    for (const key of ['dependencies', 'devDependencies', 'peerDependencies']) {
      for (const [name, version] of Object.entries(pkg[key] || {})) depRows.push([key, '`' + name + '`', '`' + version + '`'])
    }
  }
  const scriptRows = pkg && pkg.scripts ? Object.entries(pkg.scripts).map(([k, v]) => ['`npm run ' + k + '`', '`' + v + '`']) : []

  const topDirs = new Map()
  for (const file of walked.files) {
    const seg = file.rel.includes('/') ? file.rel.split('/')[0] + '/' : '(根目录)'
    if (!topDirs.has(seg)) topDirs.set(seg, { count: 0, bytes: 0 })
    const row = topDirs.get(seg)
    row.count += 1
    row.bytes += file.size
  }

  const todos = []
  let todoScanned = 0
  for (const file of walked.files) {
    if (!SOURCE_EXTS.has(file.ext)) continue
    const text = readTextSafe(file.abs)
    if (!text) continue
    todoScanned += 1
    const re = /(TODO|FIXME|XXX|HACK)\b[:\s]*(.{0,80})/g
    let m
    let guard = 0
    while ((m = re.exec(text)) !== null && guard++ < 20) {
      todos.push({ file: file.rel, line: text.slice(0, m.index).split('\n').length, tag: m[1], text: m[2].trim() })
    }
  }

  const pages = {}
  const titles = {}
  const order = []
  const headLine = gitInfo ? '`' + gitInfo.head + '` · ' + (gitInfo.latest ? gitInfo.latest.date : '') : '（非 git 仓库）'
  const generatedAt = new Date().toISOString()

  pages.overview = [
    '# ' + (basename(root) || '项目') + '：代码库速览',
    '',
    '<cite>',
    '本页由 dsh-repowiki 引擎 v' + ENGINE_VERSION + ' 于 ' + generatedAt + ' 生成',
    '项目根：`' + toPosix(root) + '`',
    'HEAD：' + headLine,
    '</cite>',
    '',
    '## 一句话',
    '这是一个 ' + topDirs.size + ' 个顶层目录、' + walked.files.length + ' 个文件（其中源码 ' + map.sourceFiles + ' 个）的仓库，',
    '当前 HEAD 是 ' + headLine + '。所有数字都可以用 `repowiki coverage` 复现。',
    '',
    '## 你现在能做什么',
    '- 想知道从哪读起：看本页「阅读顺序」，那是按依赖图排的',
    '- 想改一处代码：先跑 `repowiki diff . <range>` 拿到 review 顺序',
    '- 想知道引擎漏了什么：看「覆盖与遗漏」页，那里逐条列了跳过的路径',
    '- 想确认数字对不对：跑 `repowiki coverage <项目根>` 自己数一遍',
    '',
    '## 阅读顺序（PageRank 前 30）',
    map.ranking.slice(0, 30).length
      ? map.ranking.slice(0, 30).map((r, i) => '- ' + (i + 1) + '. `' + r.file + '` — score ' + r.score + '，被 ' + (map.inbound.get(r.file) || 0) + ' 个文件引用').join('\n')
      : '（没有解析到依赖边，无法排序）',
    '',
    '> 排序依据：把 import/require 关系当有向图跑 25 轮 PageRank（damping 0.85）。',
    '> 被依赖越多、依赖越少，排得越前。**不反映业务重要性**，只反映结构枢纽程度。',
    '',
    '## 目录分布',
    '',
    table(['顶层目录', '文件数', '体积'], [...topDirs.entries()].sort((a, b) => b[1].count - a[1].count).map(([k, v]) => ['`' + k + '`', v.count, humanSize(v.bytes)])),
    '',
  ].join('\n')
  titles.overview = '项目速览'
  order.push('overview')

  const dirCounts = new Map()
  for (const file of walked.files) {
    if (!SOURCE_EXTS.has(file.ext)) continue
    const dir = file.rel.includes('/') ? file.rel.slice(0, file.rel.lastIndexOf('/')) : '(根目录)'
    dirCounts.set(dir, (dirCounts.get(dir) || 0) + 1)
  }
  pages.structure = [
    '# 目录结构',
    '',
    '> 只列含源码的目录，按源码文件数降序。构建产物与依赖目录不在此列（见「覆盖与遗漏」）。',
    '',
    '## 源码目录',
    '',
    dirCounts.size
      ? table(['目录', '源码文件数'], [...dirCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 80).map(([k, v]) => ['`' + k + '`', v]))
      : '（未识别到源码目录）',
    '',
    '## 清单文件',
    '',
    coverage.manifests.length ? coverage.manifests.map((m) => '- `' + m + '`').join('\n') : '（无）',
    '',
  ].join('\n')
  titles.structure = '目录结构'
  order.push('structure')

  pages.deps = [
    '# 依赖与脚本',
    '',
    pkg ? '> 从 `package.json` 读出来的，版本号是声明值不是实际安装值。' : '> 没读到 `package.json`，本节只列其它语言的清单文件。',
    '',
    '## 依赖',
    '',
    depRows.length ? table(['类型', '包', '版本'], depRows.slice(0, 200)) : '（无 Node 依赖声明）',
    '',
    '## 脚本命令',
    '',
    scriptRows.length ? table(['命令', '实现'], scriptRows) : '（无 package.json scripts）',
    '',
  ].join('\n')
  titles.deps = '依赖与脚本'
  order.push('deps')

  const types = map.symbols.filter((s) => TYPE_KIND_RE.test(s.kind))
  const fns = map.symbols.filter((s) => !TYPE_KIND_RE.test(s.kind))
  pages.symbols = [
    '# 符号索引',
    '',
    '> 正则扫声明行得来，不做 AST 解析。同名不同文件都会列出来。',
    '',
    '## 类型与类（前 120）',
    '',
    types.length ? table(['文件', '行', '名字', '种类'], types.slice(0, 120).map((s) => ['`' + s.file + '`', s.line, '`' + s.name + '`', s.kind])) : '（未识别到类型声明）',
    '',
    '## 函数与方法（前 120）',
    '',
    fns.length ? table(['文件', '行', '名字', '种类'], fns.slice(0, 120).map((s) => ['`' + s.file + '`', s.line, '`' + s.name + '`', s.kind])) : '（未识别到函数声明）',
    '',
    '## 跨文件依赖（前 120）',
    '',
    map.edges.length ? table(['从', '到', '原始写法'], map.edges.slice(0, 120).map((e) => ['`' + e.from + '`', '`' + e.to + '`', '`' + e.spec + '`'])) : '（没有可解析的跨文件引用）',
    '',
    '> ' + map.note,
    '',
  ].join('\n')
  titles.symbols = '符号索引'
  order.push('symbols')

  if (gitInfo) {
    const months = new Map()
    for (const c of gitInfo.commits) {
      const key = c.date.slice(0, 7)
      if (!months.has(key)) months.set(key, [])
      months.get(key).push(c)
    }
    const blocks = []
    for (const [month, list] of months) {
      blocks.push('## ' + month + '（' + list.length + ' 次）', '')
      for (const c of list.slice(0, 30)) blocks.push('- `' + c.hash + '` ' + c.subject + ' — ' + c.author + ' · ' + c.date)
      if (list.length > 30) blocks.push('- … 本月另有 ' + (list.length - 30) + ' 次')
      blocks.push('')
    }
    pages.history = [
      '# 提交历史', '',
      table(['项', '值'], [
        ['HEAD', '`' + gitInfo.head + '`'],
        ['分支', '`' + gitInfo.branch + '`'],
        ['提交总数', gitInfo.commitCount],
        ['最近提交', gitInfo.latest ? gitInfo.latest.subject : '—'],
        ['最近作者', gitInfo.latest ? gitInfo.latest.author : '—'],
      ]),
      '', '## 按月归纳（最近 300 次）', '',
      ...blocks,
    ].join('\n')
    titles.history = '提交历史'
    order.push('history')
  }

  pages.coverage = [
    '# 覆盖与遗漏',
    '',
    '> 这一页是给「不信上面任何一页」的人看的：引擎看了什么、跳过了什么、推不出什么。',
    '',
    '## 扫到了什么',
    '',
    table(['指标', '值'], [
      ['文件总数', walked.files.length],
      ['源码文件', map.sourceFiles],
      ['源码体积', humanSize(coverage.sourceBytes)],
      ['符号声明', map.symbols.length],
      ['跨文件引用', map.edges.length],
      ['TODO/FIXME 命中', todos.length + ' 条（扫描 ' + todoScanned + ' 个源码文件）'],
      ['是否触顶', walked.truncated ? '是（达到文件上限）' : '否'],
    ]),
    '',
    '## 按扩展名',
    '',
    table(['扩展名', '语言', '文件数', '体积'], coverage.byExt.slice(0, 30).map(([ext, row]) => ['`' + ext + '`', LANG_BY_EXT[ext] || '—', row.count, humanSize(row.bytes)])),
    '',
    '## 明确跳过的路径',
    '',
    coverage.skipped.length ? table(['路径', '原因'], coverage.skipped.slice(0, 60).map((s) => ['`' + s.rel + '`', s.reason])) : '（没有跳过任何路径）',
    '',
    '## 推不出来的东西',
    '',
    coverage.limits.map((line) => '- ' + line).join('\n'),
    '',
  ].join('\n')
  titles.coverage = '覆盖与遗漏'
  order.push('coverage')

  if (todos.length) {
    pages.todos = [
      '# TODO 与 FIXME', '',
      table(['文件', '行', '标记', '内容'], todos.slice(0, 200).map((t) => ['`' + t.file + '`', t.line, t.tag, t.text])),
      '',
    ].join('\n')
    titles.todos = 'TODO 与 FIXME'
    order.push('todos')
  }

  const tree = [{
    id: 'generated',
    name: basename(root) + '（引擎生成）',
    children: order.map((id) => ({ id, name: titles[id], page: id, kw: SEARCH_WORDS[id] || '' })),
  }]

  const pagesDir = join(out, 'pages')
  mkdirSync(pagesDir, { recursive: true })
  const manifestFile = join(out, MANIFEST)
  let previous = []
  try {
    previous = JSON.parse(readFileSync(manifestFile, 'utf8')).pages || []
  } catch {
    previous = []
  }
  const written = []
  for (const id of order) {
    writeFileSync(join(pagesDir, id + '.md'), pages[id], 'utf8')
    written.push(id + '.md')
  }
  let removed = 0
  for (const name of previous) {
    if (written.includes(name)) continue
    try {
      rmSync(join(pagesDir, name), { force: true })
      removed += 1
    } catch { /* ignore */ }
  }

  writeFileSync(join(out, 'tree.json'), JSON.stringify(tree, null, 2) + '\n', 'utf8')
  const status = {
    project: toPosix(root), head: gitInfo ? gitInfo.head : null, generatedAt, engine: ENGINE_VERSION,
    filesScanned: walked.files.length, sourceFiles: map.sourceFiles,
    symbols: map.symbols.length, edges: map.edges.length, pages: order,
  }
  writeFileSync(join(out, 'status.json'), JSON.stringify(status, null, 2) + '\n', 'utf8')
  const dataJs = 'window.WIKI=' + JSON.stringify({ tree, pages, order, status }) + ';\n'
  writeFileSync(join(out, 'data.js'), dataJs, 'utf8')
  writeFileSync(manifestFile, JSON.stringify({ engine: ENGINE_VERSION, pages: written, updatedAt: generatedAt }, null, 2) + '\n', 'utf8')

  log('写出 ' + written.length + ' 页' + (removed ? '（清理过期 ' + removed + ' 页）' : '') + '，data.js ' + humanSize(Buffer.byteLength(dataJs)))
  return { outDir: toPosix(out), pages: written, removed, ms: Date.now() - began, status }
}

export function detectWikiDir(dir) {
  if (!dir) return null
  for (const name of ['data.js', 'tree.json', 'pages']) if (existsSync(join(dir, name))) return dir
  return null
}
