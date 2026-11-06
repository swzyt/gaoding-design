# 0.3.4 版权声明入口修正

日期：2026-11-06（Asia/Shanghai）。本次修正「版权声明入口判断错误」。

## 错在哪

- 之前 `publish.js` 的 `verify` 用了一个并不存在的选择器 `[data-action="open-copyright-declaration"]` 去打开版权声明弹窗；跑演唱会宣传出圈这条时该入口不存在，于是被判成“平台没提供面板”。
- 实际入口是 **我的 → 发布 → 内容卡片右下角「…」→「版权认证」**，点开就是「版权声明」弹窗（未分类 / 稿定 / 原创 / 原创 AI / 非原创 五个分区）。编辑器右上角的「版权说明」只是一段说明文案，不是面板。

## 改动

- `pipeline/workflow/copyright.js` 新增 `openPanel(page,{description})`：导航到发布列表 → 找到对应卡片 → 点「更多」→ 点「版权认证」→ 等 `.ugc-copyright-section` 出现。
- `pipeline/workflow/publish.js` 的 `verify` 改用 `copyrightFlow.openPanel`，删除失效选择器。
- `pipeline/workflow/WORKFLOW.md` 增加「版权声明入口」小节：正确入口、容易混淆的叫法、弹窗结构与提交/核验要求。
- `test-copyright.cjs` 增加入口回归用例：断言 openPanel 会导航到发布列表并点「版权认证」。
- `bash scripts/check.sh` 全部通过（Python 9 项、失败注入 20 项、submit 守卫、版权 CMS 身份、版权入口、Node 8 项、prepare-plugin 重建 runtime）。

## 线上后果

- 作品 202295493 已用正确入口完成声明，并重新打开核验：原创 8 张、原创 AI 2 张、未分类 0、两类证明材料均已保存（见 `build/sound-wave-tour/release/copyright-verified-v2.png`），交付包已重新生成。

# 0.3.3 修复记录

日期：2026-11-06（Asia/Shanghai）。本次修复弹层“白底白字、标题看不见”。

## 现象与定位

- 0.3.2 装好后弹层能正常出现（截图确认：遮罩、五条话题、取消/开始投稿按钮都在），但话题名称几乎看不见，只能看清深色的规格描述行。
- 用截图取色确认：弹层底色纯白 `#ffffff`，话题名文字 `rgb(252,251,252)`、标题 `rgb(245,248,247)`；而规格行是 `rgb(173,173,173)` 可见。深色主题下文字颜色被主题覆盖成近白色，面板底色却是硬编码白色。
- 根因：客户端用了不存在的主题变量 `--dsw-alias-bg-elevated` 和 `--dsw-alias-border`。这两个名字在 DSH 0.2.2 的 128 个 `--dsw-alias-*` 变量里都不存在，`var()` 失效后回落到硬编码的 `#ffffff`；同时 `--dsw-alias-label-primary` 是真实变量，在深色主题里解析为近白色 —— 白底 + 白字。
- 修复：改用真实存在的变量 `--dsw-alias-bg-layer-3`（浅色 `#fff` / 深色 `neutral-bluish-800`）、`--dsw-alias-border-l2`、`--dsw-alias-interactive-bg-hover`、`--dsw-alias-state-error-primary`，主按钮也改用 `--dsw-alias-state-business-primary`；勾选框加 `accentColor`。
- 新增回归测试：扫描 `client.js` 里的 `--dsw-alias-*`，必须全部落在本 DSH 实际定义的名单内。7 个 Node 单测通过。
- 已从 app.asar 抽取 128 个 `--dsw-alias-*` 变量名逐一核对，7 个变量全部存在；运行中实例返回的 bundle（rev `88452c3eed37`）已包含新变量。
- 打包 0.3.3（43 个文件），`verify-package.mjs` 通过；经 Plugin Manager 升级：`application: applied`，安装目录与 tgz 逐字节一致。

## 范围限制

- 深色/浅色主题下的实际观感需要刷新后在界面上确认；本次仍未点击“开始投稿”，输入框写入与发送路径待界面实测。
- 未新增付费生成或投稿。

# 0.3.2 修复记录

日期：2026-11-06（Asia/Shanghai）。本次修复“投稿按钮可见，但点击后弹层不出现”。

## 现象与定位

- 桌面版安装 0.3.1 后按钮可见：客户端插件已加载（`/plugins/events` 的客户端图里有 `dsh-plugin-gaoding-publisher` 行），点击时控制台无报错、页面无变化。
- 弹层原先以 `position: fixed` 写在 `conversation.session.header.actions` 槽位 DOM 内。会话框架存在 `isolation: isolate` 等层叠上下文，主内容在 header 之后绘制，固定定位的弹层会被后绘制的应用层盖住，表现为“点了没反应”。
- 修复：弹层改用 `ReactDOM.createPortal(…, document.body)` 挂到 body 末尾；`react-dom` 是 web 客户端的平台 seed，客户端 bundle 可直接 `require`。
- 新增离线回归测试：用假 React 驱动客户端 factory，断言点击后弹层通过 `createPortal` 挂到 `document.body` 且包含话题清单。6 个 Node 单测通过，`node --check client.js` 通过。
- 打包 0.3.2（43 个文件），`verify-package.mjs` 通过；经 Plugin Manager 升级安装，`application: applied`。

## 范围限制

- 弹层真实可见性需要在刷新或重启后由界面确认；本次仍未实际点击“开始投稿”，输入框写入与发送路径待界面实测。
- 未新增付费生成或投稿。

# 0.3.1 验证记录

日期：2026-11-06（Asia/Shanghai）。本次修复工具 schema 导致的插件激活失败，并重新安装到 desktop profile。

## 失败与修复

- 0.3.0 在 desktop profile 安装成功但激活失败：`JsonSchemaError: unsupported JSON schema: schema.type must be one of object/array/string/number/integer/boolean/null`。原因是工具 `output.schema` 写成 `{ type: 'json' }`，parameters 也用了只存在于宿主 `defineTool` 里的 spec 写法（`{ required: true }`）；`ctx.tools.register` 只接受宿主支持子集的原始 JSON Schema。
- 修复：三个工具输出根改为 `{ type: 'object' }`，parameters 改为标准 `{ type: 'object', properties, required }`；新增单测覆盖 schema 子集。用宿主 `@deepseek-ai/dsh-tools` 的 `assertSupportedJsonSchema` 与 `assertObjectJsonSchema` 实测 6 份 schema 全部通过。
- 打包为 0.3.1（43 个文件，runtime 清单 31 个），`node scripts/verify-package.mjs` 全部检查通过。
- 通过 Plugin Manager 安装到 desktop profile：`application: applied`，`include:gaoding-publisher` fiberPhase 为 active；43 个已安装文件与 tgz 逐字节一致；直接导入已安装插件执行 `gaoding_topics` 返回 5 个话题。
- 正式依赖位于 `~/.local/share/dsh-gaoding-publisher/dependencies`，npm 包目录不产生运行依赖。

## 范围限制

- 未做 UI 实测：本机 Web GUI 需要 `dsh web` 打印的鉴权 URL，Agent 未取得该 URL，因此没有实际点击“投稿”按钮；客户端面板是否出现需刷新或重启后在界面人工确认。界面未实测即不声称完成 UI 验收。
- 没有新增付费图像任务或投稿。下文 0.3.0 记录保留作历史。

# 0.3.0 历史验证记录

日期：2026-11-06（Asia/Shanghai）。本次是目录清理与 DSH 插件封装，不是新的真实投稿测试。

## 已验证

- 9 个 Python 测试通过：缓存失效/损坏、依赖并行、失败阻断、环检测、付费任务续跑、选题锁定、完成稿不重复发布、gate 输入校验、多画板 PSD 可重复构建。
- 5 个 Node 单测通过：话题参数和真实账号要求、工具注册销毁、后台进程状态、Agent 在后台等待期间可读取/回复 gate、已观察到发布成功时续跑不再点击发布。
- 分层验收通过 20 个故障注入点、非 100 原始透明度恢复、刷新后核验、中断恢复；投稿守卫拒绝 pending、未验证恢复与过期哈希。
- 版权 CMS URL 改写身份校验和错误作品拒绝测试通过。
- skill-creator 的 quick_validate.py 通过。已有主机 gaoding-publisher 技能同步到新说明，旧版归档。
- 安装包共 43 个文件，runtime 清单覆盖 31 个文件；解包核对 SHA256，无历史图片、任务、账号 ID、机器绝对路径或已安装依赖。
- 在带空格的独立临时目录解包，使用全新数据/依赖目录完成 bootstrap、doctor、CLI help、CommonJS 导入、后台 doctor。npm 包目录不产生运行依赖。
- DSH 0.2.2-rc.1 的临时独立 profile 安装成功，dump-config 识别 bundle 层。
- 正式 desktop profile 已安装 0.3.0；43 个已安装文件逐字节与 tgz 一致，独立依赖 bootstrap 和后台 doctor 完成且退出码为 0。
- GD CLI 仍是全局安装，验证版本 2.1.0，参考图离线回归通过；没有覆盖其安装或登录。

正式安装首次 add 后发现残留旧手工链接，虽然命令成功但实际仍为 0.2.0；已通过官方 remove/add 修复，并逐字节验证实际安装，未手写 profile 配置。正式依赖位于 ~/.local/share/dsh-gaoding-publisher/dependencies。

## 范围限制

本次没有操作 DSH 界面的“投稿”按钮，也未验证元数据图标的实际界面呈现；配置解析和 Node 工具测试不能替代这一检查。

没有新增付费图像任务或投稿。完整质量与版权门保留；视觉质量仍需 Agent 实际看图，不能由打包和单测推断。202284825 的历史投稿及约 25 分 20 秒计时仅作追溯。

当前仅验证 macOS。新的 GD CLI 安装若参考图回归失败须先修兼容性，不能跳过检查。公共 npm 未发布，registry/包名归属/公开许可证由维护者发布前确定。

## 复验

```bash
bash scripts/check.sh
npm pack ./dsh-plugin-gaoding-publisher --pack-destination ./dist
node scripts/verify-package.mjs dist/dsh-plugin-gaoding-publisher-0.3.3.tgz
```

安装包 SHA256 见 dist/SHA256SUMS；独立解包检查详情见同名 .tgz.verification.json。清理明细在 archive/cleanup-manifest.json。
