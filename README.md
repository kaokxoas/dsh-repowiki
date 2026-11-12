# dsh-repowiki

给 DeepSeek Harness 用的**确定性代码库 wiki 引擎**：扫一个源码仓库，生成可读的 wiki 页面 + 阅读顺序 + 覆盖报告，并且在 Harness 左侧栏里直接读。

**不联网、不调模型、不做 AST、不写你的项目目录。** 推不出来的东西会明写在覆盖报告里，不装懂。

> 设计取向参考了 [he-yufeng/RepoWiki](https://github.com/he-yufeng/RepoWiki)（MIT）：PageRank 阅读路径、按改动量×被依赖度排 review 顺序、诚实覆盖报告。区别是本工具**零 Python 依赖**，纯 Node ESM，产物直接是 Harness 面板能渲染的数据，并且页只删自己写过的（manifest 记账）。

---

## 一、当插件用（推荐）

插件包已经放在 `C:\Users\Administrator\.dsh\local-plugins\dsh-repowiki`，注入即生效：

```
dev_inject_plugin C:/Users/Administrator/.dsh/local-plugins/dsh-repowiki
```

注入后：

- 左侧栏出现 **RepoWiki**（order 27）
- 主区是阅读器：左边目录树、右边正文
- 四个按钮：**重新生成** / **阅读顺序** / **Review 顺序** / **覆盖报告**
- 模型侧多四个工具：`repowiki_scan` `repowiki_map` `repowiki_diff` `repowiki_coverage`

Host 半身同时起一个只读 HTTP 服务在 `127.0.0.1:34572`（面板从 `http://127.0.0.1:34572/` 也能开）。

### 配置

`cordis.patch.yml` 里 `config` 可覆盖：

| 键 | 默认 | 说明 |
|---|---|---|
| `project` | `D:/WORK/MINISO/project` | 要分析的仓库根 |
| `wikiDir` | `D:/WORK/repowiki-out` | 生成产物目录（**永远不会落在项目里**） |
| `port` | `34572` | 只读服务端口 |

---

## 二、当 CLI 用

```
node D:/WORK/repowiki/bin/repowiki.mjs help
node D:/WORK/repowiki/bin/repowiki.mjs scan     <项目根> [--out DIR] [--json]
node D:/WORK/repowiki/bin/repowiki.mjs map      <项目根> [--format json|md] [--top N]
node D:/WORK/repowiki/bin/repowiki.mjs diff     <项目根> [range] [--json]
node D:/WORK/repowiki/bin/repowiki.mjs coverage <项目根> [--json]
```

或装成全局命令：

```
npm install -g D:/WORK/repowiki
repowiki scan D:/WORK/MINISO/project --out D:/WORK/repowiki-out
```

### `scan` 产出什么

| 页 | 内容 |
|---|---|
| `overview` | 项目速览 + PageRank 阅读顺序（从哪读起） |
| `structure` | 目录树 + 各目录文件数/体积 |
| `deps` | 依赖清单 + 构建脚本 + 入口 |
| `symbols` | 符号索引（类/方法/函数/接口）+ import 引用 |
| `history` | 最近提交（仅当是 git 仓库） |
| `coverage` | 覆盖报告：扫了什么、跳了什么、**推不出来什么** |
| `todos` | TODO/FIXME 清单（有才出） |

落盘形状（和本站 `data.js` 一致，可直接被面板/站点吃）：

```
<out>/
  pages/*.md                   每页一个 markdown
  tree.json                    侧栏树：单组 generated
  status.json                  project / head / generatedAt / counts / pages
  data.js                      window.WIKI={"tree","pages","order","status"}
  .repowiki-manifest.json      记账：上次自己写过哪些页
```

**只删自己写过的页**：重扫时按 manifest 清理，你手工加进 `pages/` 的文件不会被误删。

### `map` / `diff` / `coverage`

- `map` —— PageRank 全局排序，输出「先读哪个文件」。`--format json` 可以直接喂给 scout 子 agent 当上下文索引。
- `diff` —— `<range>` 默认 `HEAD`；按「改动行数 × 被依赖度（fan-in）」排，输出 review 顺序而不是字母序。
- `coverage` —— 诚实报告：扫描文件数、源码文件数、按扩展名分布、被跳过的路径及原因、以及明确列出「这个引擎推不出来的东西」。

---

## 三、能给你省什么事

| 场景 | 原来 | 用这个 |
|---|---|---|
| 新人/新 agent 接手一个仓库 | 手动翻目录、问人 | `repowiki map` 直接给阅读顺序 |
| Code review 从哪看起 | git diff 字母序 | `repowiki diff main...HEAD` 按风险排 |
| wiki 页面靠人写 | 每页手写、易漏 | 引擎出骨架，人或 agent 只补「跑出来的判据」 |
| 担心工具乱删东西 | —— | manifest 记账，只删自己的页；项目目录只读 |

**它不替代人工/agent 写的那部分**：跑出来的错误码、踩过的坑、业务口径——这些只有真跑过才知道，引擎一律标注为「推不出来」。

---

## 四、目录

```
lib/engine.js       引擎核心：walk / gitSummary / buildMap / rankDiff / coverageReport / buildWiki
lib/index.js        Harness Host 半身：只读 HTTP + 四个模型工具
lib/client.js       Harness Client 半身：侧栏入口 + 阅读器面板
bin/repowiki.mjs    CLI 入口
cordis.patch.yml    bundle patch（把本插件插进 root 插件树）
```

## 五、约束

- 项目目录**只读**。写只写 `--out`。
- 单文件读取上限 512 KB，扫描文件上限 40000，超了写进 coverage 的 skipped。
- 不做 AST：符号和 import 靠正则，跨语言覆盖 java/kt/scala/js/ts/py/go/rb/php/cs。解析不到的引用会落到 `edges=0`，不猜。

## License

MIT
