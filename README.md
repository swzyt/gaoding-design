# 稿定话题投稿工作流 / DSH 插件

权威源码在本目录。DSH 插件包名 `dsh-plugin-gaoding-publisher`，0.4默认走原生分层、本地排版、可替换DSH图像能力和浏览器素材登记，默认不调用GD CLI；旧任务保留显式兼容后端。开发者修改这里的源码后重新打包，不修改旧 DSH 工作区副本或生成的 `runtime/`。

## Agent 入口

先读 [AGENTS.md](AGENTS.md) 和 [执行手册](pipeline/workflow/WORKFLOW.md)。在 DSH 中先调用 `gaoding_topics`，它返回完整技能说明、运行路径与依赖状态。用户已选话题或授权随机选择时直接执行，不重复询问。

## 目录

| 路径 | 用途 |
| --- | --- |
| `workflow.sh` | 本地统一 CLI 入口 |
| `pipeline/workflow/` | 总控、研究缓存、独立任务并行、分层验收、投稿及版权核验 |
| `pipeline/generate_masters.py` | 校验研究并原样传递 Agent 写的完整 prompt |
| `pipeline/topics.json` | 旧任务兼容索引；新选题来自实时创作者中心目录 |
| `dsh-plugin-gaoding-publisher/topic-catalog.js` | 登录浏览器实时话题、完整性与时间、目录共享 |
| `dsh-plugin-gaoding-publisher/spec-catalog.js` | 公开创作规范抓取、解析、缓存与索引（画布/禁止项/方向/配图） |
| `dsh-plugin-gaoding-publisher/browser-session.js` | 登录态探测与打开登录页，不收集账号密码 |
| `dsh-plugin-gaoding-publisher/jobs-store.js` | 创作任务队列、话题快照冻结、结果索引与预览 |
| `dsh-plugin-gaoding-publisher/published.js` | 只读发布管理：已投稿列表、审核状态、浏览/下载/使用统计、话题 |
| `dsh-plugin-gaoding-publisher/creator.js` | 生成素材图：默认走 DSH 订阅出图（0 稿豆），兼容 gd-cli（消耗稿豆），落盘尺寸/透明/哈希 |
| `dsh-plugin-gaoding-publisher/image-client.js` | 插件自己出图（复用订阅凭据）、缩放与白底自动抠透明 |
| `dsh-plugin-gaoding-publisher/asset-handoff.js` | 素材交接协议：请求、回执校验（哈希/尺寸/alpha） |
| `dsh-plugin-gaoding-publisher/template-recipe.js` | 分层配方归一化 + 版式质量门（字号/对比度/边距/压字） |
| `dsh-plugin-gaoding-publisher/publish-queue.js` | 发布队列：串行、落盘、可停止可续跑 |
| `dsh-plugin-gaoding-publisher/prompt-writer.js` | 调宿主 LLM 自动生成单元创作 prompt（含分层计划），用户确认后冻结 |
| `dsh-plugin-gaoding-publisher/publish-check.js` | 投稿前检查：模板 14 项（图层/契约/按层版权）、素材 7 项（尺寸/透明/哈希） |
| `pipeline/workflow/native_design.py` | 一个原创方向、2–4套原生版式、逐页预览与选优 |
| `pipeline/workflow/agent_assets.py` | 非CLI素材交接、真实工具记录和哈希验证 |
| `tooling/spec_to_psd.js` | 可编辑 PSD 输出 |
| `dsh-plugin-gaoding-publisher/` | DSH 工具、选题界面、技能和包元数据 |
| `scripts/`、`docs/` | 打包验证及发布说明；文档索引见 [docs/README.md](docs/README.md) |
| `archive/` | 历史任务、旧说明、迁移记录与清理清单；不参与运行或分发 |
| `dist/` | 生成的安装包与校验值 |

## 话题与规范控制台

[插件说明](dsh-plugin-gaoding-publisher/README.md)：左侧导航「稿定投稿」打开控制台，四个标签页覆盖话题与规范、创作、结果与投稿、已投稿。支持全自动链路（prompt → 出图 → 排版 → 投稿 → 版权声明 → 回读核验），出图默认复用 DSH 已登录的订阅凭据，不消耗稿豆。
[使用教程](docs/USAGE.md)按步骤讲从环境自检到投稿、批量与故障排查（包内同一份 `dsh-plugin-gaoding-publisher/USAGE.md`，面板右上角也能直接打开）；
[版本变更](dsh-plugin-gaoding-publisher/CHANGELOG.md)记录 0.29 以来的关键修复；工程细节与踩坑记录见[能力演进笔记](docs/SPEC-CATALOG.md)。

## 0.4 优化

[选型、实现和验证边界](docs/OPTIMIZATION-0.4.md)：默认不调用Gaoding CLI；实时目录、原生版式比较、文字保真和真实版权证据已接入。外部图像后端使用已有可用能力，不虚构免费额度或服务任务。

## 创作者知识库

[创作者玩法与规则知识库](docs/creator-center/README.md)保存2026-11-06对稿定创作者中心70篇目录文档、2篇补充链接和首页的采集与逐篇分析，包含质量/分层、版权/收益、历史案例、规则冲突及插件改进方案。它是研究快照，生产仍需核对当期规则；本地研究配图不进入插件安装包。

## 本地开发

仅验证 macOS。默认需要全局 `ego-browser`、Node、npm、Python 3，并在当前浏览器完成稿定登录；图像素材通过已经可用且授权的DSH插件/本地工具准备。GD CLI 仅显式兼容路线需要，不安装在项目或插件中。文字预览依赖 macOS 的 Songti 和 Arial Unicode。`doctor --legacy-cli` 才检查CLI。真实生成/浏览器过程证据与程序生成的索引分开，索引不能当平台版权证明。

```bash
./workflow.sh bootstrap
./workflow.sh doctor
./workflow.sh --help
```

源码运行依赖默认在 `pipeline/.venv` 和 `pipeline/workflow/node_modules`。插件运行依赖、缓存、订阅与新任务默认在 `~/.local/share/dsh-gaoding-publisher/`，不会写入 npm 安装目录。可通过 `GAODING_DATA_DIR` 改数据目录，`GAODING_RUNTIME_HOME` 改依赖目录；插件工具返回实际路径。

## 构建与发布

```bash
bash scripts/check.sh
mkdir -p dist
npm pack ./dsh-plugin-gaoding-publisher --pack-destination ./dist
```

`prepack` 自动将白名单源码复制到插件 `runtime/`，附 SHA256 清单；不会携带账号、历史素材、任务回执或 node_modules。详见 [发布和安装指南](docs/RELEASING.md)。当前是可分发安装包，尚未发布到公共 npm registry。
