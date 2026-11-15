/**
 * contract.js —— 从 Host 半身抽出来的纯函数契约层（可被测试直接 import）
 * ---------------------------------------------------------------------------
 * 这些函数原本内联在 lib/index.js 里，与 cordis 运行时耦合，导致：
 *   · 测试无法覆盖（import lib/index.js 会拖入 cordis）
 *   · 只能靠「复制一份逻辑」来测，而复制品和真货会慢慢脱节
 * 抽出来后 lib/index.js 引用这里，测试也引用这里，测的就是真货。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 路由前缀，Host 的 8 条 API 与测试共用同一常量。 */
export const API_PREFIX = '/@dsh-external/dsh-repowiki/api'

/**
 * 允许出现在 pages/<id>.md 里的 id 形态。
 * 路径分隔符、`..`、`.` 与空串一律不允许——它们拼进路径后可能指向目录本身，
 * 读出来是 EISDIR 或者更糟的东西。
 */
const PAGE_ID_RE = /^[A-Za-z0-9._-]+$/

export function isValidPageId(id) {
  if (typeof id !== 'string') return false
  if (id === '' || id === '.' || id === '..') return false
  return PAGE_ID_RE.test(id)
}

/**
 * 读取一个 wiki 目录的打包数据（data.js 里的 window.WIKI=...）。
 * 三种结果，调用方都必须能处理：
 *   · 没有 data.js        → null（还没生成）
 *   · 解析成功            → 对象
 *   · 解析失败            → { error: string }（不抛，避免一条坏数据打挂整个面板）
 */
export function readWikiBundle(dir) {
  let raw
  try {
    raw = readFileSync(join(dir, 'data.js'), 'utf8')
  } catch {
    return null
  }
  try {
    const prefix = raw.indexOf('window.WIKI=')
    const json = prefix >= 0 ? raw.slice(prefix + 'window.WIKI='.length).replace(/;\s*$/, '') : raw
    return JSON.parse(json)
  } catch (error) {
    return { error: 'data.js 解析失败：' + String(error && error.message ? error.message : error) }
  }
}

/** 单页 markdown 的读取；id 不合法或文件不存在都返回 null。 */
export function readWikiPage(dir, id) {
  if (!isValidPageId(id)) return null
  try {
    return readFileSync(join(dir, 'pages', id + '.md'), 'utf8')
  } catch {
    return null
  }
}
