// 临时探针：找出 walkProject 卡在哪个路径
import { readdirSync, statSync, lstatSync } from 'node:fs'
import { join } from 'node:path'

const root = process.argv[2] || 'D:/WORK/MINISO/project'
const SKIP = new Set(['node_modules', '.git', 'target', 'dist', 'build', 'out', '.idea', '.gradle', '.mvn', '.next', 'coverage'])
let count = 0
let last = Date.now()

const slow = []
function walk(dir, depth) {
  if (depth > 14) return
  let ents
  try {
    ents = readdirSync(dir, { withFileTypes: true })
  } catch (e) {
    console.error('READDIR FAIL', dir, e.code)
    return
  }
  for (const e of ents) {
    const p = join(dir, e.name)
    if (e.isSymbolicLink()) {
      console.error('SYMLINK', p)
      continue
    }
    if (e.isDirectory()) {
      if (SKIP.has(e.name)) continue
      walk(p, depth + 1)
      continue
    }
    if (!e.isFile()) {
      console.error('NOT-FILE', p)
      continue
    }
    count += 1
    const t0 = Date.now()
    try {
      statSync(p)
    } catch (err) {
      console.error('STAT FAIL', p, err.code)
    }
    const dt = Date.now() - t0
    if (dt > 40) slow.push([dt, p])
    if (count % 500 === 0) {
      console.log('progress', count, 'depth', depth, 'elapsed', Date.now() - last, 'ms')
      last = Date.now()
    }
  }
}

const t0 = Date.now()
walk(root, 0)
console.log('DONE files', count, 'total', Date.now() - t0, 'ms')
console.log('SLOW (>=40ms):')
for (const [dt, p] of slow.slice(0, 40)) console.log('  ', dt, 'ms', p)
