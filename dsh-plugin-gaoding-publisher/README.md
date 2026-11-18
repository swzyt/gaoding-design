# 稿定话题投稿 · DSH 插件

在 DSH 里把「读话题 → 写 prompt → 出图/排版 → 投稿 → 版权声明 → 核对结果」整条链路做掉。

- **默认零稿豆**：素材用 DSH 已登录的 ChatGPT 订阅凭据生成，插件自己调，不需要人工或 Agent 介入。
- **全自动可闭环**：`全自动` 模式从生成 prompt 一路跑到投稿完成，中途不停。
- **声明必须真实**：模板在发布会话内完成版权声明并回读平台记录，未回读成功不算完成。
- **不谎报状态**：列表状态来自真实产物与投稿记录，空列表、缺面板、审核中都不当成功。

当前版本见 `package.json`（`0.41.x`）。第一次用请直接看 **[使用教程](./USAGE.md)**（从打开面板到投出第一篇），历史变更见 [CHANGELOG.md](./CHANGELOG.md)。

---

## 1. 安装

要求：macOS（仅此平台验证过）、Node、Python 3、已登录稿定的 ego-browser，并具有素材库与投稿权限。

桌面版用 **Plugin Manager** 安装发行包（`dist/dsh-plugin-gaoding-publisher-<version>.tgz`）。
不要手工改 profile 里的安装副本；源码改动要重新打包再装，装完刷新页面（旧模块会缓存）。

```bash
# 开发流程
bash scripts/check.sh                                     # 静态检查 + 全部单测
npm pack ./dsh-plugin-gaoding-publisher --pack-destination ./dist
node scripts/verify-package.mjs dist/dsh-plugin-gaoding-publisher-<version>.tgz
# 然后在 Plugin Manager 里装这个 tgz
```

数据目录默认 `~/.local/share/dsh-gaoding-publisher`（`GAODING_DATA_DIR` 可改），运行时依赖装在该目录自己的 `.venv`，不写进包目录。

---

## 2. 面板

左侧导航「稿定投稿」，四个标签页。

### 进入页面先做环境自检

打开面板会先跑一次依赖检查（`GET /preflight`，30 秒缓存），顶部直接给结论：

| 检查项 | 缺失时的处理 |
|---|---|
| 数据目录可写 | **阻塞**：创作/投稿禁用，提示改用 `GAODING_DATA_DIR` |
| Python 运行时（含 Pillow） | **阻塞**：提示重装插件或 `pip install Pillow` |
| ego-browser 浏览器工具 | **阻塞**：提示安装或设置 `EGO_BROWSER_BIN` |
| 稿定浏览器登录态 | 提示：去「检查登录」 |
| DSH 图像插件（dsh-image-gen） | 提示：到 Plugin Manager 安装，否则没有订阅登录与出图入口 |
| 出图能力（订阅凭据） | 提示：登录订阅账号，或后端改 GD CLI（全自动会停在等待素材） |
| GD CLI（可选） | 仅提示，不影响默认路径 |
| 插件版本 | 显示当前版本，配合顶部「插件已更新，请刷新」横幅 |

- 全部正常显示一行绿字「环境自检通过：N 项依赖就绪」；
- 有缺失项时列出「检查项：原因 → 修复建议」，**阻塞项存在时创作与投稿按钮直接禁用**；
- 随时可点「重新检查」强制重探（自检只读，不安装任何东西、不触发付费动作）。

### 话题与规范

实时读[创作者中心灵感页](https://creator.huaban.com/inspiration)，显示条数、更新时间与完整性；支持搜索、类型筛选。目录不完整或读取失败时**禁止投稿**，不用固定五项冒充最新列表。

选中话题后可直接「用这个话题创建创作任务」，跳到创作页并带上方向与规范。

### 创作

- **数量**：1–20，默认 1；每个单元方向不同。
- **模式**：`手动`（人工确认 prompt）或 `全自动`（prompt 自动确认并直接跑到投稿）。
- **出图后端**：
  | 后端 | 说明 | 成本 |
  |---|---|---|
  | `DSH 出图（0 稿豆）` | 插件复用 DSH 图像插件已登录的订阅凭据，自己发请求 | 订阅额度，**0 稿豆** |
  | `本机 GD CLI` | 走 gaoding CLI 的 Seedream | 稿豆 |
  | `交给 Agent` | 插件写好素材请求并停住，由对话里的 Agent 出图 | 取决于 Agent 用什么 |

- **prompt**：每个单元可展开查看/编辑；确认后只读。默认收起，只显示两行摘要，避免占满屏。
- **状态**：单元与任务状态都来自真实产物（已投稿 > 投稿中 > 已创作待投稿 > 创作中 > 等待素材 > 失败 > 待创作 > 排队中），不会把已投稿的单元显示成「排队中」。
- **链路状态**：等待素材、自动中断、需要处理分别用不同颜色；已全部投稿的任务不再显示陈旧的链路错误。

### 结果与投稿

- 左侧是创作产物（模板 PSD/预览、素材图），可先「检查」再创建投稿任务。
- 任务支持**勾选批量投稿 / 批量取消**；运行中显示当前步骤与已耗时。
- **发布队列**：一键把全部待投任务依次投完；状态条显示完成/失败/待投、失败原因摘要，「停止」= 当前件跑完即停，剩余可续跑。队列状态落盘，插件重启不丢。

### 已投稿

读平台发布管理（自动翻页取全量）：作品 ID、标题、类型、审核状态、声明状态、话题、浏览/下载、发布时间。

- 状态徽标**点击即筛选**（已通过 / 审核中 / 审核不通过 / 待声明）；
- 按时间 / 浏览 / 下载排序；导出 CSV；每行可跳平台详情。

**状态判定口径**（以平台字段为准）：

| 显示 | 判定 |
|---|---|
| 已通过 | `audit_cqc_status=1` |
| 审核中 | `audit_cqc_status=0` 或 `audit_crc_status=0` |
| 审核不通过 | `audit_cqc_status=2` 或 `publish_status=QUALITY_REJECTED` |
| 待声明 | `publish_status=WAITING_MATERIALS` 或声明未提交 |

> 模板的声明不体现在 `material_declaration_status`（该字段恒为 null），要看 `/api/v3/cp/ugc/contents/<id>/copyright-declarations` 的记录条数。

---

## 3. 一次投稿经历什么

```
读话题规范 → Agent 写 prompt（人工或自动确认）
  → 需要素材：插件调订阅出图（约 20s/张）→ 缩放 + 白底自动抠透明 → 校验哈希/尺寸/alpha
  → 模板：模型给分层配方 → 版式硬门槛 → 本地渲染 PSD（文字保持原生可编辑）
  → 编辑器导入 → 发布（描述/话题/含 AI 生成内容）→ 发布成功 → 去完善
  → 版权声明（整稿按来源归类 + 上传真实证据）→ 提交 → 重开面板回读平台记录
  → 记录 published + contentId + declarationStatus
```

### 质量门槛（渲染前拦截）

| 规则 | 阈值 |
|---|---|
| 文字安全边距 | 60px，越界自动收进来 |
| 字号 | ≥24px；层级 ≤4 档；主标题 ≥ 正文 1.6 倍 |
| 文字对比度 | 大字号 ≥3:1，小字号 ≥4.5:1（WCAG 相对亮度） |
| 背景 | 必须铺满画布 |
| 主体 | ≤35% 画布面积 |
| 装饰 | 纯色装饰层直接丢弃；图像装饰不得铺满画布 |
| 压字 | 除容器外任何图层压到文字直接拒绝 |
| 图层数 | ≤16 |

### 版权声明口径

- **含 AI 图层的模板**：整稿声明「原创 AI 素材」。平台候选按内容去重、预览图还会重编码，逐张区分 AI 图与程序图形容易错声明，所以保守统一声明，既不隐瞒也不夸大。
- **纯程序绘制**：声明「原创素材」。
- **素材稿**：单区上传证据，`declaration-verified: SUBMITTED` 才算完成。
- 证据必须覆盖每个图片层；`receipts.png` 之类只是索引，不能当平台证据上传。

---

## 4. HTTP 路由

插件在 Host 的 webServer 上挂这些路由（面板用的就是它们）：

| 路由 | 用途 |
|---|---|
| `GET /topics`、`GET /specs`、`POST /specs/refresh` | 话题目录与规范 |
| `GET /session`、`POST /session/probe`、`POST /session/login` | 浏览器登录态 |
| `GET/POST /jobs`、`POST /jobs/remove` | 创作任务 |
| `POST /pipeline/run` | 跑自动链路（批量/重试） |
| `GET /results`、`GET /preview` | 创作产物 |
| `GET/POST /prompts`、`POST /prompts/confirm`、`POST /prompts/generate` | prompt 审核 |
| `POST /create`、`GET /create/status`、`GET /create/preview` | 触发创作 |
| `POST /publish`、`GET /publish`、`POST /publish/run` | 投稿任务 |
| `POST /publish/check`、`POST /publish/remove` | 投稿前检查、删除 |
| `POST /publish/batch`、`POST /publish/cancel` | 批量投稿、取消未开始的任务 |
| `GET/POST /publish/queue` | 发布队列（查询 / 启动 / 停止） |
| `POST /publish/reconcile`、`POST /publish/resolve-uncertain` | 对账（含无 contentId 的不确定提交） |
| `POST /publish/abandon`、`POST /publish/republish` | 放弃记录、撤销重发（补声明） |
| `POST /image/test` | 自检：能否用订阅凭据出图 |
| `GET /published` | 已投稿列表（翻页/筛选/排序） |
| `GET /health` | 版本与自检 |

---

## 5. 目录结构

```
index.js               插件入口：路由、工具、编排（创作/投稿/队列）
client.js              面板（sidebar.panellist + main），纯 JS
jobs-store.js          创作任务与投稿任务存储、状态推导
prompt-writer.js       prompt 生成（LLM）
creator.js             创作：素材稿（gd-cli / image-gen）与调用模板流程
image-client.js        插件自己出图（复用订阅凭据）+ 缩放/白底抠图
asset-handoff.js       素材交接协议（请求/回执/校验）
template-recipe.js     分层配方归一化 + 版式质量门 + 本地渲染
template-declaration.js 声明计划、证据、平台回读
template-publish.js    模板投稿脚本（发布 + 声明 + 核验）
publisher.js           素材投稿脚本（发布 + 声明 + 核验），含撤销作品
published.js           已投稿列表与状态判定
publication-safety.js  提交指纹、识别新作品、核验
publish-queue.js       发布队列（串行、落盘、可续跑）
browser-space.js       浏览器空间复用/创建
publish-check.js       投稿前检查
auto-publish.js        全自动链路编排
skill/SKILL.md         Agent 侧技能说明
CHANGELOG.md           版本变更
```

---

## 6. 常见问题

**为什么「全自动」会停在等待素材？**
只有两种情况：`DSH 出图` 的订阅凭据缺失/过期（点 `POST /image/test` 可自检），或后端选的是「交给 Agent」。前者重新登录 DSH 图像插件，后者本来就等 Agent。

**投稿报「已有不确定提交记录，必须先对账」**
上一次发布在「结果未知」时中断。先调 `POST /publish/resolve-uncertain`：平台确实没有新作品就归档记录允许重投；确实发出去了就把作品 ID 记下来（模板还要走撤销重发补声明）。

**模板报「没有可归类的候选」/「候选匹配不完整」**
声明面板的候选还没渲染出来，或平台去重后数量与计划不符。插件会**中止而不是猜**，避免错声明。重试即可；持续失败就查该作品的编辑器内容是否含未登记素材。

**模板已发布但没有声明**
模板的声明入口只在发布会话里出现一次。用 `POST /publish/republish`（需 `force: true`）：确认平台无声明记录 → 撤销旧作品 → **重新导入新设计** → 重发并声明。复用同一个设计时平台不再给「去完善」入口，所以必须重导入。

**投稿很慢**
单个模板 4–6 分钟（编辑器导入 + 渲染 + 声明会话），素材 1–3 分钟。批量用发布队列串行跑，不要并发（同一浏览器空间只能串行）。

**插件热重装会打断正在跑的任务**
会。重装会重建插件进程，运行中的创作/投稿中断。中断的素材会复用，不会重复消耗额度；但正在投稿那一步要做对账。

---

## 7. 数据与合规

- 包内只有运行代码、技能与元数据；不含账号、历史任务、机器路径、研究素材、node_modules 或虚拟环境（`scripts/verify-package.mjs` 会扫描这几项）。
- 生成与投稿记录（含任务 ID、素材哈希、作品 ID）保存在数据目录，用于核对与恢复。
- 付费动作（GD CLI 出图）需要用户确认；本插件默认路径不消耗稿豆。
- UNLICENSED：公开分发前由维护者确定许可与 registry。
