/**
 * manifests.js —— 多语言依赖清单解析（零依赖，纯正则）
 * ---------------------------------------------------------------------------
 * 为什么不用 XML/JSON 库：这个插件对外的硬承诺是「零第三方依赖、只用 node 内置」，
 * 为了读 pom.xml 引入 xml2js 会破坏这条承诺。pom.xml 的结构足够规整，
 * 正则能覆盖 99% 的真实工程；解析不到的情况一律**如实退回**，不猜。
 *
 * 支持：
 *   · Maven  pom.xml        —— 直接依赖 + dependencyManagement（标注来源）
 *   · Gradle build.gradle   —— implementation / api / compileOnly / runtimeOnly 等
 *   · Node   package.json   —— dependencies / devDependencies / peerDependencies
 *
 * 明确做不到的（会在 coverage 的 limits 里说）：
 *   · Maven 的 profile 激活、parent 继承链上的版本仲裁、BOM 展开
 *   · Gradle 的 buildSrc / versionCatalog(libs.versions.toml) / 变量拼接
 *   · 任何需要联网或需要跑构建工具才能得到的「实际解析结果」
 */

/* ------------------------------------------------------------------ Maven */

/** 取第一个 <tag>…</tag> 的文本内容；没有则返回 null。 */
function tag(xml, name) {
  const re = new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>')
  const m = re.exec(xml)
  return m ? m[1].trim() : null
}

/**
 * 解析 pom.xml。
 * 返回 { groupId, artifactId, version, packaging, deps, managed, parent }
 *   deps    —— <dependencies> 里的直接依赖
 *   managed —— <dependencyManagement> 里的版本声明（不一定会被用到，单独标注）
 */
export function parsePom(xml) {
  if (typeof xml !== 'string' || !xml.includes('<project')) return null

  const projectTag = /<project\b([^>]*)>/.exec(xml)
  const ns = projectTag && /\sxmlns(:\w+)?="([^"]+)"/.exec(projectTag[1])
  void ns

  // parent 段要先摘掉，否则 tag() 会误取到 parent 里的 groupId/version
  const parentBlock = tag(xml, 'parent') || ''
  const parent = parentBlock
    ? {
        groupId: tag(parentBlock, 'groupId'),
        artifactId: tag(parentBlock, 'artifactId'),
        version: tag(parentBlock, 'version'),
      }
    : null

  const withoutParent = xml.replace(/<parent[\s\S]*?<\/parent>/, '')
  const withoutMgmt = withoutParent.replace(/<dependencyManagement[\s\S]*?<\/dependencyManagement>/g, '')

  // 只取 project 的直接子级 groupId/artifactId/version：先掐掉 <dependencies> 与 <build>
  const headOnly = withoutMgmt
    .replace(/<dependencies[\s\S]*?<\/dependencies>/g, '')
    .replace(/<build[\s\S]*?<\/build>/g, '')
    .replace(/<profiles[\s\S]*?<\/profiles>/g, '')
    .replace(/<modules[\s\S]*?<\/modules>/g, '')

  const groupId = tag(headOnly, 'groupId') || (parent && parent.groupId) || null
  const artifactId = tag(headOnly, 'artifactId') || null
  const version = tag(headOnly, 'version') || (parent && parent.version) || null
  const packaging = tag(headOnly, 'packaging') || 'jar'
  const modules = collectTagTexts(withoutMgmt, 'module')

  const mgmtBlocks = [...withoutParent.matchAll(/<dependencyManagement[\s\S]*?<\/dependencyManagement>/g)].map((m) => m[0])
  const managed = []
  for (const block of mgmtBlocks) {
    for (const dep of collectDeps(block)) managed.push(dep)
  }

  return {
    groupId,
    artifactId,
    version,
    packaging,
    modules,
    parent,
    deps: collectDeps(withoutMgmt),
    managed,
  }
}

function collectTagTexts(xml, name) {
  const out = []
  const re = new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>', 'g')
  let m
  while ((m = re.exec(xml)) !== null) out.push(m[1].trim())
  return out
}

/** 取一段 XML 里所有 <dependency>…</dependency>。 */
function collectDeps(xml) {
  const out = []
  const blocks = [...xml.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)]
  for (const block of blocks) {
    const body = block[1]
    const groupId = tag(body, 'groupId')
    const artifactId = tag(body, 'artifactId')
    if (!groupId || !artifactId) continue
    out.push({
      groupId,
      artifactId,
      version: tag(body, 'version'),
      scope: tag(body, 'scope') || 'compile',
      optional: tag(body, 'optional') === 'true',
    })
  }
  return out
}

/* ------------------------------------------------------------------ Gradle */

const GRADLE_DEP_RE = /^\s*(implementation|api|compileOnly|runtimeOnly|testImplementation|testRuntimeOnly|annotationProcessor|kapt|ktsImplementation)\s*\(?\s*['"]([^:'"]+):([^:'"]+)(?::([^'"]+))?['"]/gm

/**
 * 解析 build.gradle / build.gradle.kts 里的坐标式依赖。
 *
 * 变量拼接的坐标（`"$group:$name:$version"`）**一律丢弃**并记进 notes：
 * 早先的正则会把 `${libName}` 原样当成 artifactId，生成一条看着像真、
 * 实则无意义的依赖——这比"没解析到"更糟，读者会当成事实。
 */
export function parseGradle(text) {
  if (typeof text !== 'string') return null
  const deps = []
  const skipped = []
  let m
  GRADLE_DEP_RE.lastIndex = 0
  while ((m = GRADLE_DEP_RE.exec(text)) !== null) {
    const [, configuration, groupId, artifactId, version] = m
    const dynamic = [groupId, artifactId, version].some((part) => part && (part.includes('$') || part.includes('+')))
    if (dynamic) {
      skipped.push({ configuration, raw: [groupId, artifactId, version].filter(Boolean).join(':') })
      continue
    }
    deps.push({ configuration, groupId, artifactId, version: version || null })
  }
  if (!deps.length && !skipped.length && !/plugins\s*\{|dependencies\s*\{/.test(text)) return null
  return { deps, skipped, pluginBlock: /plugins\s*\{/.test(text) }
}

/* ------------------------------------------------------------------ Node */

export function parsePackageJson(text) {
  try {
    const pkg = JSON.parse(text)
    if (!pkg || typeof pkg !== 'object') return null
    const deps = []
    for (const kind of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const [name, version] of Object.entries(pkg[kind] || {})) {
        deps.push({ kind, name, version: String(version) })
      }
    }
    return { name: pkg.name || null, version: pkg.version || null, deps, scripts: pkg.scripts || {} }
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ 汇总 */

export const MANIFEST_FILES = {
  packageJson: 'package.json',
  pom: 'pom.xml',
  gradleGradle: 'build.gradle',
  gradleKts: 'build.gradle.kts',
}

/**
 * 从一个项目的清单文件集合里汇总依赖。
 * @param {{find:(rel:string)=>string|null}} reader  按仓库相对路径读文本，读不到返回 null
 * @param {string[]} rels                            walkProject 得到的全部文件相对路径
 */
export function collectManifests(reader, rels) {
  const result = {
    maven: [],      // [{ module, pom }]
    gradle: [],     // [{ file, gradle }]
    node: [],       // [{ file, pkg }]
    manifests: [],  // 命中的清单文件相对路径
    notes: [],      // 解析局限性的如实说明
  }

  // 只看非构建产物目录里的 pom.xml（walkProject 已经滤过，这里再挡一次 target/）
  for (const rel of rels) {
    const base = rel.slice(rel.lastIndexOf('/') + 1)
    if (rel.includes('target/') || rel.includes('build/') || rel.includes('node_modules/')) continue

    if (base === 'pom.xml') {
      const text = reader(rel)
      if (!text) continue
      const parsed = parsePom(text)
      if (!parsed) {
        result.notes.push('`' + rel + '` 看起来不是标准 Maven pom（缺少 <project>），已跳过')
        continue
      }
      result.maven.push({ module: rel.slice(0, -'pom.xml'.length).replace(/\/$/, '') || '(根)', pom: parsed })
      result.manifests.push(rel)
      continue
    }

    if (base === 'build.gradle' || base === 'build.gradle.kts') {
      const text = reader(rel)
      if (!text) continue
      const parsed = parseGradle(text)
      if (!parsed) continue
      result.gradle.push({ file: rel, gradle: parsed })
      result.manifests.push(rel)
      continue
    }

    if (base === 'package.json') {
      const text = reader(rel)
      if (!text) continue
      const parsed = parsePackageJson(text)
      if (!parsed) {
        result.notes.push('`' + rel + '` 不是合法 JSON，已跳过')
        continue
      }
      result.node.push({ file: rel, pkg: parsed })
      result.manifests.push(rel)
    }
  }

  if (result.maven.length) {
    result.notes.push('Maven 只读 `<dependencies>` 与 `<dependencyManagement>`：parent 继承链上的版本仲裁、profile 激活、BOM 展开都拿不到，看到 `-` 不等于没有版本')
  }
  if (result.gradle.length) {
    const skippedTotal = result.gradle.reduce((acc, entry) => acc + (entry.gradle.skipped ? entry.gradle.skipped.length : 0), 0)
    result.notes.push('Gradle 只认坐标式写法（`implementation "g:a:v"`）：version catalog、buildSrc 常量、变量拼接出来的坐标拿不到' +
      (skippedTotal ? '（本次丢弃了 ' + skippedTotal + ' 条含变量的坐标）' : ''))
  }

  return result
}
