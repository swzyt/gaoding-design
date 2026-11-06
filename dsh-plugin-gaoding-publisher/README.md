# 稿定话题投稿 · DSH 插件

选择话题后，Agent 基于详情页十张样例与规范撰写完整创意，工作流推进母稿、独立素材、原生文字、PSD、DAM 绑定、投稿、版权声明、发布管理核验和素材包交付。视觉判断仍需 Agent 实际看图，不是仅装插件就能无人验收。

## 安装

支持 DSH `>=0.2.0 <0.3.0`，目前仅验证 macOS。需要全局 GD CLI、ego-browser、Node、npm、Python 3，当前用户需登录稿定并有 DAM 与投稿权限。

通过 DSH Plugin Manager 安装发行的 `.tgz`，或使用官方 CLI：

```bash
dsh plugin --profile desktop add /absolute/path/dsh-plugin-gaoding-publisher-0.3.4.tgz
```

更新已加载的旧版本后重启 DSH。包内包含流水线，不需要原开发工作区。若从源码目录链接安装，先在仓库根运行 `node scripts/prepare-plugin.mjs`。

## 使用

在会话头部“投稿”选择话题，或让 Agent 调用 `gaoding_topics` 获取完整指引及实际路径。首次调用 `gaoding_workflow` 的 bootstrap，然后 status 等待完成，再 doctor 检查。

三个工具：`gaoding_topics`（索引和操作指引）、`gaoding_subscribe`（选题及真实账号空间绑定）、`gaoding_workflow`（后台执行及状态查询）。所有后台命令立即返回 directory，后续用 status 查询；启动成功不代表投稿完成。

数据默认写到 `~/.local/share/dsh-gaoding-publisher`，不写 npm 包目录。`GAODING_DATA_DIR` 可改变数据位置；`GAODING_RUNTIME_HOME` 可改变依赖位置。GD CLI、浏览器登录和用户 profile 不由插件覆盖。

分层、视觉和版权验收要求详见包内 `skill/SKILL.md` 与 `runtime/pipeline/workflow/WORKFLOW.md`。用户仅请求预览时不得使用会自动投稿的 auto。

## 分发范围

包只包含运行代码、技能、元数据与源码 SHA256；不含账号、历史投稿、素材、node_modules 或虚拟环境。版权证明及任务证据留在用户数据目录。当前发行采用 UNLICENSED，未授予公开开源许可；公开分发前由维护者确定许可和 registry。
