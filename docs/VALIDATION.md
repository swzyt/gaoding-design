# 0.4.0 原生分层与非CLI默认路线

日期：2026-11-06（Asia/Shanghai）。实现选择和范围见 [优化说明](OPTIMIZATION-0.4.md)。

## 本轮已验证

- 完整 `bash scripts/check.sh` 退出0：35项Python、16项Node；另含20个分层失败注入点、非100透明度恢复、刷新与中断恢复、投稿守卫、版权CMS身份和声明入口。
- 通过真实登录浏览器从灵感页的实际200响应读取137题，126条有规范链接、11条无链接，status complete；无链接记录未丢弃。单独区分规则URL和样例hub。
- 原生流程离线测试走实际预览渲染/选优，多画板逐页生成并锁定每页哈希；测试阻断一切subprocess调用，确认此阶段无CLI调用。测试中的研究与审查均是临时fixture，不称真实投稿研究。
- 文字专项验证PSD重新读取字体、行距、字距、对齐、描边、文本框和DPI，以及文字层真实像素缓存；现有多画板可重复构建回归通过。
- 版权上传拒绝生成索引、缺层证据、过期审查和被改图片；外部来源/透明度/路径/任务恢复及真实原件打包有专项测试。
- 发行包49个文件，runtime清单36个条目（含runtime/package.json）。解包逐哈希、无历史图像/账号/机器路径、独立runtime发现、CommonJS导入、全新可写依赖bootstrap、默认doctor、CLI help和后台完成全部通过。
- 应用自带DSH 0.2.2-rc.1 CLI在独立DSH_HOME/profile安装成功，dump-config识别插件bundle；未复制正式账号配置，未启动替代Web服务器。
- 当前desktop profile通过Plugin Manager从0.3.4更新到0.4.0：application applied；实际49个安装文件与tgz逐字节一致。已注册工具读取137题，实际现有GUI插件路由返回HTTP200/complete137；默认后台doctor退出0，日志明确native/Agent/browser、不检查GD CLI。
- 两套本地原生排版演示已渲染并实际看图，第二套调整说明文字避免压住圆环。未调用模型、上传或投稿。

包SHA256：`a55732ae2c6135b5be58594e90823594d047138e03f2d608bd7144ca0e0d43f3`。

## 本轮边界

- 新浏览器窗口访问当前DSH地址需要Desktop私有会话认证，因此本轮没有完成真实GUI面板点击/视觉验收；已验证实际路由和离线React面板逻辑。若当前客户端仍缓存旧bundle需刷新页面。
- 未执行新的真实素材上传、PSD导入、AI图像任务或投稿。浏览器Agent登记、外部图像服务与稿定字体重新排版仍需在获授权生产任务逐项验证，不能拿本地单测替代。
- 未安装/配置新的图像供应商；当前未发现已启用的独立生图插件。文字/程序图形本地可运行，复杂图像需要真实可用的DSH插件/本地模型或原创素材。默认不自动退回GD CLI。
- GD CLI兼容代码和旧run恢复保留，只有明确选择该路线才调用；新默认doctor不要求CLI。本轮不承诺费用或性能节省比例。

以下保留历史版本的当时验证，不作为0.4原生路线的生产通过记录。

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

# 0.4.4 优化版打包与隔离安装验证

日期：2026-11-08（Asia/Shanghai）。本节追加保留既有验证记录。本轮只升级插件 package.json 的 0.4.3 → 0.4.4，通过 scripts/prepare-plugin.mjs 重建 runtime，写入 dist 验证产物和本节；保留原有 dirty 源码改动。

- 完整 `PYTHONDONTWRITEBYTECODE=1 bash scripts/check.sh` 退出 0：134 项 Python、79 项 Node；另含 20 个分层失败注入点、原透明度/刷新/中断恢复、投稿守卫、版权 CMS 身份与声明入口检查。默认 doctor 通过，未调用真实浏览器。
- `npm pack ./dsh-plugin-gaoding-publisher --pack-destination ./dist` 退出 0；prepack 从当前源码白名单生成 runtime。包有 56 个文件，runtime manifest 有 43 个哈希条目（42 个源码文件加 runtime/package.json）。新增 browser_metrics.py、browser_sequence.js、publication_preflight.py、review_packet.py 均已包含。
- `node scripts/verify-package.mjs dist/dsh-plugin-gaoding-publisher-0.4.4.tgz` 退出 0。解包哈希、历史素材/机器路径/账号禁入检查、独立 runtime 发现、CommonJS 导入、全新依赖 bootstrap、doctor/help、后台命令完成及依赖不写入包目录检查均通过；结果为同名 `.tgz.verification.json`。
- 应用自带 DSH CLI 版本 0.2.2-rc.1，使用临时 DSH_HOME 的 gaoding-test profile 执行 add 和 dump-config 均退出 0，bundle 层识别 `dsh-plugin-gaoding-publisher` / `gaoding-publisher`。安装后的 56 个文件逐字节与 tgz 一致，43 个 runtime 清单哈希与当前源码一致。
- 首次独立 DSH_HOME 位于 `/tmp/gaoding-0.4.4-validation.d271Zq/dsh-home`；内置 pnpm 仍报告复用共享 `~/Library/pnpm/store/v11` 包缓存，因此不声称首次验证连缓存都完全隔离。未清理或修改该共享缓存配置。随后显式隔离 PNPM_HOME、缓存和 DSH_HOME，在 `/tmp/gaoding-0.4.4-validation.d271Zq/strict-dsh-home` 再次成功 add/dump-config；日志确认包 store 位于临时目录的 `pnpm-home/store/v11`。严格隔离安装的 56 个文件及当前源码哈希核对也通过。
- 所有启动的后台工具任务均已回收且退出 0；进程快照未发现本轮测试/验证残留进程。临时安装与核验脚本保留以便复查，未复制真实账号配置或凭证。

发行包绝对路径：`<repo>/dist/dsh-plugin-gaoding-publisher-0.4.4.tgz`。

SHA256：`7eb342e198347cd48abd768508d50add3a95a7591301d855d5c52fa78a38e892`。

完整命令输出、状态快照与 SHA256 留存于 `dist/validation-0.4.4-20261108/`：check.log、npm-pack.log、verify-package.log、dsh-version.log、isolated-install.log、dump-config.log、installed-content.log，以及 strict-isolated-install.log、strict-dump-config.log、strict-installed-content.log。上述命令退出码全部为 0。

本轮边界与遗留任务：未操作浏览器、当前 desktop profile 或 Plugin Manager；未执行真实上传、付费生成、投稿及版权重开核验。由 Lead 安装已验证的同一个 tgz 到当前 profile，确认运行版本和 UI/工具激活，再执行已获授权的真实完整流程。离线/隔离通过不代表生产视觉、版权或审核通过；公共 npm 未发布。

# 0.4.5 native bootstrap 与研究采集修复打包验证

日期：2026-11-08（Asia/Shanghai）。本轮只将插件 package.json 从 0.4.4 升到 0.4.5，由 scripts/prepare-plugin.mjs 生成 runtime，写入 dist 产物并追加本节；保留既有 dirty 与全部 0.4.4 证据。打包包含现有源码修复：bootstrap 默认移除 GD CLI 强依赖、workflow.sh 参数传递、研究采集滚动分页按钮、aria-label 懒加载卡片读取与 RISO 大小写匹配。

- 完整 `PYTHONDONTWRITEBYTECODE=1 bash scripts/check.sh` 退出 0：146 项 Python、80 项 Node，另含分层失败注入、恢复、投稿守卫及版权检查；默认 doctor 明确 native/Agent/browser，无 GD CLI 强依赖。新增 bootstrap 测试已包含在完整 Python discovery 中。
- `npm pack ./dsh-plugin-gaoding-publisher --pack-destination ./dist` 与 `node scripts/verify-package.mjs dist/dsh-plugin-gaoding-publisher-0.4.5.tgz` 均退出 0；56 个包文件、43 个 runtime manifest 条目。解包哈希、禁入信息、独立 runtime/CommonJS、全新依赖 bootstrap、doctor/help、后台完成和包内不写依赖检查均通过。
- 使用应用自带 CLI `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`（0.2.2-rc.1），从新建隔离目录执行 `plugin --profile gaoding-test add` 和 `--profile gaoding-test --dump-config`，均退出 0，识别插件 bundle。未复制真实 profile、账户或凭证。
- 从首次安装即显式隔离 DSH_HOME、PNPM_HOME、XDG_CACHE_HOME、npm cache/store、Corepack 缓存及空白 npm 用户/全局配置。隔离根为 `<repo>/dist/validation-0.4.5-20261108/isolation`；安装日志确认 store 位于该根的 `pnpm-home/store/v11`，未使用共享 Library/pnpm/store。可复核命令和环境保存在 strict-install.sh 与 isolation-environment.log。
- 安装后的 56 个文件与同一个 tgz 逐字节匹配；43 个 runtime 哈希与当前源码一致（runtime/package.json 与生成物核对，其余 42 项与源码核对）。strict-installed-content.log 记录核验结果，verify-installed.py 保留核验逻辑。
- 本轮三个后台工具任务（完整 check、pack/verify、隔离 add/dump-config）全部回收，exit 0；包验证内启动的后台 doctor 也已验证 exit 0。进程快照未发现本轮测试/验证残留，只有采样命令自身。

可安装的已验证同一发行包：`<repo>/dist/dsh-plugin-gaoding-publisher-0.4.5.tgz`。

SHA256：`e9b955b168385be02496a4d8420c7bc5ad3e1e9045ea19c756c97eae25e6cd94`。

完整证据位于 `dist/validation-0.4.5-20261108/`：check.log、npm-pack.log、verify-package.log、dsh-version.log、strict-isolated-install.log、strict-dump-config.log、strict-installed-content.log、对应 .exit、SHA256SUMS、进程与 git 状态快照。包验证摘要另见 `dist/dsh-plugin-gaoding-publisher-0.4.5.tgz.verification.json`。

范围：本轮未操作浏览器、desktop 或 Plugin Manager；未新增真实 E2E、素材上传、生成、投稿和版权核验。当前 profile 升级由 Lead 使用上述已验证同一 tgz 完成，不重新打包；此前 0.4.4 的真实 E2E 及 research 失败状态不由本轮离线结果改写。公共 npm 未发布。

