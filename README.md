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

- **不新增侧栏入口**。侧栏的「RepoWiki」由 `@dsh-external/dsh-repo-wiki-studio`（order 26）提供，它的阅读器已能直接打开本工具生成的目录（`detectWikiKind` 认 `data.js` → `repowiki-data`）；本插件的 `lib/client.js` 是空实现，只保留 `dsh.client` 声明所需的占位，避免侧栏出现两个同名项
- 模型侧多四个工具：`repowiki_scan` `repowiki_map` `repowiki_diff` `repowiki_coverage`

Host 半身同时起一个只读 JSON 服务在 `127.0.0.1:34572`，面板通过它取数据。根路径 `/` 是 404——这不是网页，是一组 API：

| 路径 | 作用 |
|---|---|
| `GET /@dsh-external/dsh-repowiki/api/health` | 存活探针，返回 `ok` |
| `GET .../api/state` | 引擎版本、wikiDir、project、是否正在扫、最近日志 |
| `GET .../api/wiki` | 整包 `{tree, pages, order, status}`，面板一次拿全 |
| `GET .../api/pages?id=<id>` | 单页 markdown |
| `GET .../api/coverage?project=` / `.../api/map?project=&top=` / `.../api/diff?project=&range=` | 三份报告 |
| `POST .../api/scan` | 触发一次扫描 |

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
lib/client.js       Client 半身占位：不注册任何 slot（侧栏只留 studio 那一个）
bin/repowiki.mjs    CLI 入口
cordis.patch.yml    bundle patch（把本插件插进 root 插件树）
```

## 五、约束

- 项目目录**只读**。写只写 `--out`。
- 单文件读取上限 512 KB，扫描文件上限 40000，超了写进 coverage 的 skipped。
- 不做 AST：符号和 import 靠正则，跨语言覆盖 java/kt/scala/js/ts/py/go/rb/php/cs。解析不到的引用会落到 `edges=0`，不猜。

## 六、实测数字（不是估算）

在一个真实 Java/Vue 单体仓库上跑过（13774 个文件 / 9570 个源码文件 / 56.4 MB）：

| 项 | 值 |
|---|---|
| 扫描文件 | 13774 |
| 源码文件 | 9570（56.4 MB） |
| 抽到符号 | 17204 |
| 解析出的 import 边 | 417 |
| 生成页 | 7（`overview` `structure` `deps` `symbols` `history` `coverage` `todos`） |
| `data.js` | 121939 bytes |
| `scan` 耗时 | 前台等 240s 未返回（像卡死），**后台实际跑完、产物正常** |

`scan` 在这个量级上请后台跑再读日志，不要前台等。判断「是不是真卡死」看一个东西：输出目录里 `status.json` 有没有出现——没有就还没进写盘阶段。

PageRank 第一名的可信度抽查：`overview.md` 排第一的是 `phenix-aidp-ui/aiops/phenix-aidp-ui-aegis-component/src/utils/request.ts`（score 0.001836，被 28 个文件引用）。这是 HTTP 客户端封装，确实是全前端的汇聚点——排序结果是能对上的。

## 七、已知短板（写在前面，别踩了才发现）

| 短板 | 表现 | 为什么没修 |
|---|---|---|
| `deps` 页依赖根目录的 manifest | 项目根没有 `package.json` 时（Java 多模块仓库很常见），这页只有一句「无 Node 依赖声明」 | 按语言找 manifest 需要按构建系统分派（maven/gradle/pnpm/npm/go mod），一套做完容易各语言都半吊子；宁可明说没有 |
| `edges` 远少于 `symbols` | 17204 个符号只连出 417 条边 | 正则只认「同文件内显式 import 行 + 能 resolved 到仓库内路径」的调用；Spring 的 `@Autowired`、Vue 的动态 import、反射全部看不见 |
| 页面文字是模板 | 每页结构固定，读起来不像人写的 | 引擎不调模型。要「像人写的」，用它的产出当骨架，人或 agent 补 §三 里说的「跑出来的判据」 |
| 不做语义理解 | 无法回答「为什么这样设计」 | 静态分析拿不到设计意图 |

## 八、装成全局命令

```bash
cd D:/WORK/repowiki
npm link            # 之后 repowiki 直接可用
repowiki --version  # 1.0.0
```

没装也不影响：`node D:/WORK/repowiki/bin/repowiki.mjs <子命令>` 参数完全一样。

## License

MIT。设计取向参考 [he-yufeng/RepoWiki](https://github.com/he-yufeng/RepoWiki)（MIT）；本实现零 Python 依赖，纯 Node ESM。
