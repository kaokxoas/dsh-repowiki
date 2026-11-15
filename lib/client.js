/**
 * @dsh-external/dsh-repowiki —— Client 半身
 * ---------------------------------------------------------------------------
 * 左侧栏「RepoWiki」入口 + 主区阅读器：
 *   · 目录树（来自 data.js 的 tree）+ 页内容（data.js 的 pages）
 *   · 顶部四个按钮：重新生成 / 覆盖报告 / 阅读顺序 / Review 顺序
 *   · 全部数据从 /@dsh-external/dsh-repowiki/api 拉，不缓存
 * 样式只用 --dsw-alias-* token。
 */
try {
  window.__ModuleLoader__.load({
    id: '@dsh-external/dsh-repowiki',
    factory(require) {
      const module = { exports: {} }
      const exports = module.exports
      const React = require('react')
      const h = React.createElement
      const { useState, useEffect, useCallback, useMemo } = React

      const PANEL_ID = 'repowiki'
      const PANEL_ORDER = 27
      const API_ROOT = '/@dsh-external/dsh-repowiki/api'

      function apiUrl(path) {
        const base = typeof location !== 'undefined' && location.origin ? location.origin : 'http://127.0.0.1'
        return new URL(API_ROOT + path, base).toString()
      }

      async function getJson(path) {
        const response = await fetch(apiUrl(path), { headers: { accept: 'application/json' } })
        const text = await response.text()
        let data = null
        try {
          data = text ? JSON.parse(text) : null
        } catch {
          data = { error: '返回不是 JSON：' + text.slice(0, 120) }
        }
        if (!response.ok) throw new Error((data && data.error) || 'HTTP ' + response.status)
        return data
      }

      async function postJson(path, body) {
        const response = await fetch(apiUrl(path), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body || {}),
        })
        const text = await response.text()
        let data = null
        try {
          data = text ? JSON.parse(text) : null
        } catch {
          data = { error: text.slice(0, 200) }
        }
        if (!response.ok) throw new Error((data && data.error) || 'HTTP ' + response.status)
        return data
      }

      /* -------------------------------------------------- 极简 markdown */

      function inline(text) {
        const nodes = []
        let rest = String(text)
        let key = 0
        const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))/
        while (rest.length) {
          const match = pattern.exec(rest)
          if (!match) {
            nodes.push(rest)
            break
          }
          if (match.index > 0) nodes.push(rest.slice(0, match.index))
          const token = match[0]
          if (token.startsWith('`')) {
            nodes.push(h('code', { key: 'c' + key++, className: 'rw-code-inline' }, token.slice(1, -1)))
          } else if (token.startsWith('**')) {
            nodes.push(h('strong', { key: 'b' + key++ }, token.slice(2, -2)))
          } else if (token.startsWith('*')) {
            nodes.push(h('em', { key: 'i' + key++ }, token.slice(1, -1)))
          } else {
            const inner = /\[([^\]]+)\]\(([^)]+)\)/.exec(token)
            nodes.push(h('a', { key: 'a' + key++, href: inner[2], target: '_blank', rel: 'noreferrer' }, inner[1]))
          }
          rest = rest.slice(match.index + token.length)
        }
        return nodes
      }

      function renderMarkdown(source) {
        const lines = String(source || '').split('\n')
        const blocks = []
        let i = 0
        let key = 0

        const flushParagraph = (buffer) => {
          if (!buffer.length) return
          blocks.push(h('p', { key: 'p' + key++ }, inline(buffer.join(' '))))
          buffer.length = 0
        }
        const paragraph = []

        while (i < lines.length) {
          const line = lines[i]

          if (!line.trim()) {
            flushParagraph(paragraph)
            i += 1
            continue
          }

          if (/^```/.test(line)) {
            flushParagraph(paragraph)
            const lang = line.slice(3).trim()
            const body = []
            i += 1
            while (i < lines.length && !/^```/.test(lines[i])) {
              body.push(lines[i])
              i += 1
            }
            i += 1
            blocks.push(
              h('div', { key: 'code' + key++, className: 'rw-codeblock' },
                lang ? h('div', { className: 'rw-codeblock-lang' }, lang) : null,
                h('pre', null, body.join('\n'))),
            )
            continue
          }

          if (/^<cite>\s*$/.test(line)) {
            flushParagraph(paragraph)
            const body = []
            i += 1
            while (i < lines.length && !/^\s*<\/cite>/.test(lines[i])) {
              body.push(lines[i])
              i += 1
            }
            i += 1
            blocks.push(h('div', { key: 'cite' + key++, className: 'rw-cite' }, body.map((l) => h('div', { key: 'l' + key++ }, inline(l)))))
            continue
          }

          const heading = /^(#{1,6})\s+(.*)$/.exec(line)
          if (heading) {
            flushParagraph(paragraph)
            const level = heading[1].length
            blocks.push(h('div', { key: 'h' + key++, className: 'rw-h rw-h' + level }, inline(heading[2])))
            i += 1
            continue
          }

          if (/^\|/.test(line) && i + 1 < lines.length && /^\|[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
            flushParagraph(paragraph)
            const header = splitRow(line)
            i += 2
            const rows = []
            while (i < lines.length && /^\|/.test(lines[i])) {
              rows.push(splitRow(lines[i]))
              i += 1
            }
            blocks.push(
              h('div', { key: 'tbl' + key++, className: 'rw-tablewrap' },
                h('table', { className: 'rw-table' },
                  h('thead', null, h('tr', null, header.map((cell, ci) => h('th', { key: 'th' + ci }, inline(cell))))),
                  h('tbody', null, rows.map((row, ri) => h('tr', { key: 'tr' + ri }, row.map((cell, ci) => h('td', { key: 'td' + ci }, inline(cell)))))))),
            )
            continue
          }

          if (/^[-*+]\s+/.test(line)) {
            flushParagraph(paragraph)
            const items = []
            while (i < lines.length && /^[-*+]\s+/.test(lines[i])) {
              items.push(lines[i].replace(/^[-*+]\s+/, ''))
              i += 1
            }
            blocks.push(h('ul', { key: 'ul' + key++, className: 'rw-ul' }, items.map((item, ii) => h('li', { key: 'li' + ii }, inline(item)))))
            continue
          }

          if (/^>\s?/.test(line)) {
            flushParagraph(paragraph)
            const items = []
            while (i < lines.length && /^>\s?/.test(lines[i])) {
              items.push(lines[i].replace(/^>\s?/, ''))
              i += 1
            }
            blocks.push(h('blockquote', { key: 'q' + key++, className: 'rw-quote' }, items.map((item, qi) => h('div', { key: 'qd' + qi }, inline(item)))))
            continue
          }

          paragraph.push(line)
          i += 1
        }
        flushParagraph(paragraph)
        return blocks
      }

      function splitRow(line) {
        return line.replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map((cell) => cell.trim())
      }

      /* -------------------------------------------------- 图标 */

      function PanelIcon({ size, active }) {
        return h(
          'svg',
          {
            viewBox: '0 0 16 16',
            width: size || 18,
            height: size || 18,
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: active ? 1.5 : 1.3,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            'aria-hidden': 'true',
          },
          h('path', { key: 'a', d: 'M2.5 13.2V3.4c1.3-.5 2.6-.4 4 .4v9.4c-1.4-.8-2.7-.9-4-.4z' }),
          h('path', { key: 'b', d: 'M13.5 13.2V3.4c-1.3-.5-2.6-.4-4 .4v9.4c1.4-.8 2.7-.9 4-.4z' }),
          h('path', { key: 'c', d: 'M8 3.6v10' }),
        )
      }

      const CSS = `
.rw-root { display:flex; flex-direction:column; height:100%; min-height:0; background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); font-size:13px; }
.rw-head { display:flex; align-items:flex-start; justify-content:space-between; gap:14px; padding:18px 22px 12px; border-bottom:1px solid var(--dsw-alias-border-l1); }
.rw-title { font-size:15px; font-weight:600; }
.rw-sub { margin-top:4px; font-size:11.5px; color:var(--dsw-alias-label-tertiary); line-height:1.5; word-break:break-all; }
.rw-actions { display:flex; gap:7px; flex-shrink:0; flex-wrap:wrap; justify-content:flex-end; }
.rw-btn { height:27px; padding:0 10px; border-radius:7px; border:1px solid var(--dsw-alias-border-l2); background:transparent; color:var(--dsw-alias-label-primary); font-size:12px; cursor:pointer; white-space:nowrap; }
.rw-btn:hover { background:var(--dsw-alias-interactive-bg-hover); }
.rw-btn:disabled { opacity:.45; cursor:not-allowed; }
.rw-btn.primary { border-color:var(--dsw-alias-border-l3); font-weight:600; }
.rw-body { flex:1; min-height:0; display:flex; }
.rw-nav { width:232px; flex-shrink:0; border-right:1px solid var(--dsw-alias-border-l1); overflow:auto; padding:10px 8px 24px; }
.rw-nav-group { padding:8px 8px 4px; font-size:10.5px; font-weight:600; letter-spacing:.6px; text-transform:uppercase; color:var(--dsw-alias-label-tertiary); }
.rw-nav-item { display:block; width:100%; text-align:left; padding:5px 9px; border-radius:6px; border:none; background:transparent; color:var(--dsw-alias-label-secondary); font-size:12.5px; cursor:pointer; }
.rw-nav-item:hover { background:var(--dsw-alias-interactive-bg-hover); color:var(--dsw-alias-label-primary); }
.rw-nav-item.active { background:var(--dsw-alias-interactive-bg-selected, var(--dsw-alias-interactive-bg-hover)); color:var(--dsw-alias-label-primary); font-weight:600; }
.rw-main { flex:1; min-width:0; overflow:auto; padding:20px 26px 60px; }
.rw-h { margin:18px 0 8px; font-weight:600; line-height:1.35; }
.rw-h1 { font-size:19px; margin-top:0; }
.rw-h2 { font-size:15.5px; padding-bottom:5px; border-bottom:1px solid var(--dsw-alias-border-l1); }
.rw-h3 { font-size:13.5px; }
.rw-h4, .rw-h5, .rw-h6 { font-size:12.5px; }
.rw-main p { margin:8px 0; line-height:1.72; color:var(--dsw-alias-label-secondary); }
.rw-main ul { margin:8px 0; padding-left:18px; }
.rw-main li { margin:4px 0; line-height:1.7; color:var(--dsw-alias-label-secondary); }
.rw-quote { margin:10px 0; padding:8px 12px; border-left:2px solid var(--dsw-alias-border-l3); color:var(--dsw-alias-label-tertiary); font-size:12px; line-height:1.65; }
.rw-cite { margin:10px 0 14px; padding:8px 12px; border-radius:7px; background:var(--dsw-alias-bg-subtle, rgba(127,127,127,.07)); font-size:11.5px; color:var(--dsw-alias-label-tertiary); line-height:1.7; word-break:break-all; }
.rw-codeblock { margin:10px 0; border-radius:8px; border:1px solid var(--dsw-alias-border-l1); overflow:hidden; }
.rw-codeblock-lang { padding:4px 10px; font-size:10.5px; letter-spacing:.5px; text-transform:uppercase; color:var(--dsw-alias-label-tertiary); border-bottom:1px solid var(--dsw-alias-border-l1); }
.rw-codeblock pre { margin:0; padding:10px 12px; overflow:auto; font-size:12px; line-height:1.6; font-family:ui-monospace,Menlo,Consolas,monospace; }
.rw-code-inline { padding:1px 5px; border-radius:4px; background:var(--dsw-alias-bg-subtle, rgba(127,127,127,.12)); font-size:12px; font-family:ui-monospace,Menlo,Consolas,monospace; }
.rw-tablewrap { margin:10px 0; overflow:auto; }
.rw-table { border-collapse:collapse; font-size:12px; width:100%; }
.rw-table th, .rw-table td { border:1px solid var(--dsw-alias-border-l1); padding:5px 9px; text-align:left; vertical-align:top; }
.rw-table th { background:var(--dsw-alias-bg-subtle, rgba(127,127,127,.06)); font-weight:600; }
.rw-pre { margin:10px 0; padding:12px 14px; border-radius:8px; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-subtle, rgba(127,127,127,.05)); font-size:11.5px; line-height:1.65; overflow:auto; white-space:pre-wrap; font-family:ui-monospace,Menlo,Consolas,monospace; }
.rw-empty { margin:40px auto; max-width:520px; text-align:center; color:var(--dsw-alias-label-tertiary); font-size:12.5px; line-height:1.8; }
.rw-err { margin:12px 0; padding:10px 12px; border-radius:7px; border:1px solid var(--dsw-alias-border-l2); color:var(--dsw-alias-label-primary); font-size:12px; }
`

      /* -------------------------------------------------- 主页面 */

      function RepoWikiPage() {
        const [bundle, setBundle] = useState(null)
        const [state, setState] = useState(null)
        const [active, setActive] = useState('')
        const [panel, setPanel] = useState(null)
        const [busy, setBusy] = useState('')
        const [error, setError] = useState('')
        const [note, setNote] = useState('')

        const load = useCallback(async () => {
          setError('')
          try {
            const info = await getJson('/state')
            setState(info)
            const data = await getJson('/wiki')
            setBundle(data)
            if (!active && data.order && data.order.length) setActive(data.order[0])
          } catch (err) {
            setError(String(err && err.message ? err.message : err))
            setBundle(null)
          }
        }, [active])

        useEffect(() => { load() }, [])

        const pages = bundle && bundle.pages ? bundle.pages : {}
        const order = bundle && bundle.order ? bundle.order : []
        const tree = bundle && bundle.tree ? bundle.tree : []
        const titles = useMemo(() => {
          const map = {}
          for (const group of tree) for (const node of group.children || []) map[node.id] = node.name
          return map
        }, [bundle])

        const runScan = async () => {
          setBusy('scan')
          setNote('')
          setError('')
          try {
            const result = await postJson('/scan', { project: state && state.project })
            setNote('已生成 ' + (result.pages ? result.pages.length : 0) + ' 页，耗时 ' + result.ms + ' ms')
            await load()
          } catch (err) {
            setError(String(err && err.message ? err.message : err))
          } finally {
            setBusy('')
          }
        }

        const runPanel = async (kind) => {
          setBusy(kind)
          setNote('')
          setError('')
          try {
            const project = state && state.project
            if (kind === 'coverage') {
              const report = await getJson('/coverage?project=' + encodeURIComponent(project))
              setPanel({ kind, text: [
                '文件 ' + report.filesScanned + ' / 源码 ' + report.sourceFiles,
                'git HEAD：' + (report.head || '（非 git 仓库）'),
                '',
                '按扩展名（前 15）：',
                ...report.byExt.slice(0, 15).map(([ext, row]) => '  ' + ext + '  ' + row.count + ' 个'),
                '',
                '跳过的路径（前 30）：',
                ...(report.skipped.length ? report.skipped.slice(0, 30).map((s) => '  ' + s.rel + '  —  ' + s.reason) : ['  （没有跳过）']),
                '',
                '推不出来的东西：',
                ...report.limits.map((line) => '  · ' + line),
              ].join('\n') })
            } else if (kind === 'map') {
              const report = await getJson('/map?project=' + encodeURIComponent(project) + '&top=40')
              setPanel({ kind, text: [
                '扫描 ' + report.filesScanned + ' 文件 / 源码 ' + report.sourceFiles + ' / 符号 ' + report.symbolCount + ' / 边 ' + report.edgeCount,
                '',
                '阅读顺序：',
                ...report.ranking.map((row, i) => '  ' + (i + 1) + '. ' + row.file + '  score=' + row.score),
                '',
                report.note,
              ].join('\n') })
            } else {
              const report = await getJson('/diff?project=' + encodeURIComponent(project) + '&range=HEAD')
              setPanel({ kind, text: [
                '改动 ' + report.filesChanged + ' 个文件，+' + report.totalAdded + ' / -' + report.totalDeleted,
                '',
                ...(report.files.length
                  ? report.files.slice(0, 40).map((row, i) => '  ' + (i + 1) + '. +' + row.added + '/-' + row.deleted + '  fanIn=' + row.fanIn + '  ' + row.file)
                  : ['  （没有已跟踪文件的改动）']),
              ].join('\n') })
            }
          } catch (err) {
            setError(String(err && err.message ? err.message : err))
          } finally {
            setBusy('')
          }
        }

        const body = () => {
          if (error && !bundle) {
            return h('div', { className: 'rw-empty' },
              h('div', null, '还没有可读的 wiki。'),
              h('div', { style: { marginTop: 8 } }, error),
              h('div', { style: { marginTop: 14 } },
                h('button', { type: 'button', className: 'rw-btn primary', onClick: runScan, disabled: busy === 'scan' },
                  busy === 'scan' ? '正在生成…' : '扫描当前项目生成 wiki')))
          }
          if (panel) {
            return h('div', null,
              h('div', { className: 'rw-h rw-h1' }, panel.kind === 'coverage' ? '覆盖报告' : panel.kind === 'map' ? '阅读顺序与依赖' : 'Review 顺序'),
              h('pre', { className: 'rw-pre' }, panel.text),
              h('button', { type: 'button', className: 'rw-btn', onClick: () => setPanel(null) }, '返回正文'))
          }
          if (!active || !pages[active]) {
            return h('div', { className: 'rw-empty' }, '选左侧一页开始读。')
          }
          return h('div', null, renderMarkdown(pages[active]))
        }

        return h('div', { className: 'rw-root' },
          h('style', null, CSS),
          h('div', { className: 'rw-head' },
            h('div', { style: { minWidth: 0 } },
              h('div', { className: 'rw-title' }, 'RepoWiki'),
              h('div', { className: 'rw-sub' },
                state ? (state.project || '未设置项目') : '正在读取…',
                state && state.wikiDir ? ' → ' + state.wikiDir : '')),
            h('div', { className: 'rw-actions' },
              h('button', { type: 'button', className: 'rw-btn primary', onClick: runScan, disabled: busy === 'scan' },
                busy === 'scan' ? '生成中…' : '重新生成'),
              h('button', { type: 'button', className: 'rw-btn', onClick: () => runPanel('map'), disabled: Boolean(busy) }, '阅读顺序'),
              h('button', { type: 'button', className: 'rw-btn', onClick: () => runPanel('diff'), disabled: Boolean(busy) }, 'Review 顺序'),
              h('button', { type: 'button', className: 'rw-btn', onClick: () => runPanel('coverage'), disabled: Boolean(busy) }, '覆盖报告'))),
          note ? h('div', { className: 'rw-err', style: { margin: '0 22px' } }, note) : null,
          error && bundle ? h('div', { className: 'rw-err', style: { margin: '0 22px' } }, error) : null,
          h('div', { className: 'rw-body' },
            h('div', { className: 'rw-nav' },
              tree.length
                ? tree.map((group) => h('div', { key: group.id },
                    h('div', { className: 'rw-nav-group' }, group.name),
                    (group.children || []).map((node) => h('button', {
                      key: node.id,
                      type: 'button',
                      className: 'rw-nav-item' + (node.id === active ? ' active' : ''),
                      onClick: () => { setActive(node.id); setPanel(null) },
                    }, node.name || node.id))))
                : h('div', { className: 'rw-nav-group' }, order.length ? '页面' : '（空）'),
              !tree.length && order.length
                ? order.map((id) => h('button', {
                    key: id,
                    type: 'button',
                    className: 'rw-nav-item' + (id === active ? ' active' : ''),
                    onClick: () => { setActive(id); setPanel(null) },
                  }, titles[id] || id))
                : null),
            h('div', { className: 'rw-main' }, body())))
      }

      // 侧栏只保留一个 RepoWiki（站点管理器 @dsh-external/dsh-repo-wiki-studio）。
      // 本插件不再注册 sidebar.panellist，避免同名项重复出现；能力走 4 个 repowiki_* 工具、
      // HTTP API（34572）与命令行（repowiki scan|map|diff|coverage）。
      function apply(ctx) {
        const slots = ctx.slots
        slots.inject('main', () => slots.register({ name: 'main', key: PANEL_ID }, RepoWikiPage))
      }

      exports.apply = apply
      exports.inject = ['slots']
      return module.exports
    },
  })
} catch (error) {
  if (typeof console !== 'undefined' && console.warn) console.warn('[dsh-repowiki] client load failed', error)
}
