# 稿定话题投稿工作流 / DSH 插件

权威源码在本目录。DSH 插件包名 `dsh-plugin-gaoding-publisher`；开发者修改这里的源码后重新打包，不修改旧 DSH 工作区副本或生成的 `runtime/`。

## Agent 入口

先读 [AGENTS.md](AGENTS.md) 和 [执行手册](pipeline/workflow/WORKFLOW.md)。在 DSH 中先调用 `gaoding_topics`，它返回完整技能说明、运行路径与依赖状态。用户已选话题或授权随机选择时直接执行，不重复询问。

## 目录

| 路径 | 用途 |
| --- | --- |
| `workflow.sh` | 本地统一 CLI 入口 |
| `pipeline/workflow/` | 总控、研究缓存、独立任务并行、分层验收、投稿及版权核验 |
| `pipeline/generate_masters.py` | 校验研究并原样传递 Agent 写的完整 prompt |
| `pipeline/topics.json` | 选题索引与规范摘要，实时规范以网页为准 |
| `tooling/spec_to_psd.js` | 可编辑 PSD 输出 |
| `dsh-plugin-gaoding-publisher/` | DSH 工具、选题界面、技能和包元数据 |
| `scripts/`、`docs/` | 打包验证及发布说明 |
| `archive/` | 历史任务、旧说明、迁移记录与清理清单；不参与运行或分发 |
| `dist/` | 生成的安装包与校验值 |

## 本地开发

仅验证 macOS。需要全局 `gd-cli`、`ego-browser`、Node、npm、Python 3，并在当前账户完成稿定登录。GD CLI 不安装在项目或插件中。字体证明生成依赖 macOS 的 Songti 和 Arial Unicode。

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
