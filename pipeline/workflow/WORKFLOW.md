# 从实时话题到原生可编辑投稿

这是当前执行规范。**新任务默认 native + agent：本地原生排版、独立图像素材、DSH 图像能力交接、浏览器登记与投稿；默认流程不调用 GD CLI。** Agent 负责创意、完整素材 prompt、真实工具操作和视觉验收；总控负责确定性处理、哈希、持久状态与恢复。`auto` 会最终投稿，仅在用户授权投稿时运行。

## 安装、目录与唯一浏览器空间

1. 先调用 `gaoding_topics` 读取完整 guide、workflowGuide、实际路径及目录状态。面板打开时实时刷新，来源是 `https://creator.huaban.com/inspiration`；不是语雀教程目录或历史五项列表。接口需要登录时，读取现有登录浏览器真实响应，不读取或保存认证头。
2. 复用返回的 `space` 作为整个目标唯一 TaskSpace。已有目标空间时传 `gaoding_topics {space:实际ID,refresh:true}`，不要再建第二个。目录读取用独立临时 Page，不覆盖编辑器页。目录返回 `complete/partial/unavailable`、时间、数量；失败不把缓存当实时成功。
3. 首次 `gaoding_workflow ["bootstrap"]`，用 `["status",directory]` 等退出0，再 `["doctor"]`。需要全局 ego-browser、Node、npm、Python；默认 bootstrap 与 doctor 均不检查或执行 GD CLI，也不运行其参考图编码测试。仅显式 `["bootstrap","--legacy-cli"]` 或 `["doctor","--legacy-cli"]` 验证可选 GD CLI 兼容工具及参考图编码；bootstrap 未知参数会明确报错，依赖安装或兼容检查失败会以非零退出，不得视为初始化成功。插件不偷偷安装或覆盖全局工具。当前仅验证 macOS，中文预览使用系统字体。
4. 数据默认 `~/.local/share/dsh-gaoding-publisher`：runs、subscriptions、catalog、research-cache、dependencies、operations；工具返回路径为准。`GAODING_DATA_DIR`、`GAODING_RUNTIME_HOME` 可显式指定数据/依赖根目录；`GAODING_WORKSPACE` 仅开发切换源码。运行包不依赖原开发工作区。

## 话题、启动与恢复

用户已选题、选全部或授权随机时不重复询问。调用 `gaoding_subscribe` 传当前目录 key 和同一 `space`；`repositoryId` 可省略，只有已经查到真实当前库 ID 才传，不用历史账号或虚构占位值。每题快照落盘，通过 `--topic-json` 贯通总控和研究器，分别保存规范 URL 和样例 hub。目录中缺链接的话题仍显示；研究无法明确找到唯一详情页时如实停止，不套其他题规范。

```text
gaoding_workflow args=["auto","绝对运行目录","--topic","动态key","--topic-json","本题快照绝对路径","--space","本次ID","--mode","native","--registration","agent","--watch"]
gaoding_workflow args=["status","同一运行目录"]
```

订阅返回的 args 优先，多个话题串行运行。新 native 任务必须先冻结本次选题；明确随机授权时，Agent 在完整实时目录的可参与题中随机选一次、记录方法并登记，不能从历史五项池声称全目录随机。

选题快照、space、repository、mode、registration 一经保存续跑必须一致。已有旧 run 无 mode 字段按 gd-cli/gd-cli 恢复，不在中途切换路线。新任务仅显式 `--mode gd-cli --registration gd-cli --repository-id 真实ID` 才走旧母稿/双分层路线；不作自动降级，也不承诺旧CLI免费。独立 `job/masters/register` 仍是显式CLI兼容命令。任务不确定时先查询原任务/上传/发布记录，禁止重发、删锁或手改 run.json 标 done。

若旧TaskSpace确已消失，遵守ego-browser技能先取得用户的新空间恢复授权；之后可用 `recover-space 运行目录 --previous-space 旧ID --space 新ID --user-authorized`。命令实时核实旧空间缺失、新空间由Agent持有、进程已退出、无其它写锁且有原作品永久URL，只更新空间绑定并另存恢复历史，所有阶段/作品ID/素材和开始时间保持不变。续跑沿用原参数仅改space；原订阅保持历史记录。禁止把该命令当无授权自动重建或重新导入捷径。

所有非 status 命令立即后台返回；启动不代表完成。`--watch` 等待 Agent gate，有进程时不要重复启动。只预览用 `preview 配方 --output 路径`、`build 配方` 等手动阶段，不运行 auto。

## Native 默认阶段与交接契约

### 研究与创意

`research_collect` 实看当前话题 TOP1–TOP3 与列表前七张、完整规范及规范图。保存来源、截图、字节哈希；列表七张不称额外七张排名。缓存只复用有哈希的研究，并复核本次实时规范。

`01-creative`：Agent 打开十张样例和规范，写 research/analysis.md、research-review.json（passed:true，samples十条逐张具体分析），标记重复系列。写 creative-brief.json：

- `research:{sources:"sources.json",analysis:"analysis.md"}`；`concepts` 恰好一个原创方向。
- concept 必填 `id,concept,reading_path,zones,copy,layers,palette,typography`。不要程序拼接 prompt 或沿用旧坐标。
- `layout_variants` 为2–4个真正不同的版式/配色方案，每项 `{id,recipe:"layout-a.json",rationale}`；recipe 文件都在 concept 根目录，素材相对该根目录。
- `asset_plan:{assets:[{id,source:"assets/subject.png",require_alpha:true,...本素材完整prompt/独立背景/用途}]}`。仅列实际外部图片需求；纯文字/程序形状用 assets:[]。整幅海报不作为默认生图请求。
- 新任务必须明确 `separation_contract:{schema_version:1,objects:[{id,layer_id,role,require_alpha,coverage?}]}`，按用户要求列出所有独立对象，不把整套场景写成一个物件。每个对象映射不同的 recipe layer ID；各层显式写相同的 role/require_alpha。`foreground` 必须 require_alpha:true；`background` 必须声明 `coverage:{box:[x,y,w,h],page?:"画板ID"}`，允许明确约定的局部背景，不默认要求每块背景都满画布。两个独立杯子可以复用同一图片文件，但不能共用同一图层。只有纯原生文字/形状且无外部图片才可显式 objects:[]。

契约冻结在 native-input.json 与 separation-contract.json；版式渲染、选版、进入浏览器前和最终审查复核来源/成品PNG哈希、透明和对象映射。每个非背景对象必须是 layer_audit.pairs 中单独的 subject。缺物件、同层冒充两个对象、缺有效透明区、PNG内容变化都会提前失败。旧已冻结任务没有契约时保留原恢复路径并明确 legacy-unverified，不能宣称通过新的结构验收。**结构检查不识别物件身份，也不能证明背景没有烘焙副本；仍须逐对象实看隐藏图和完整背景。**

总控冻结 native-input.json 与 asset-plan.json，生成 agent-assets/request.json。按层创作：独立完整背景、人物、物件，标题/日期/地点/价格保持原生文本；研究图不能附作生产参考素材。

### 素材与版式比较

`02-assets`：Agent 使用已经授权且可用的 DSH 图像插件、本地工具或原创素材；优先现有能力，不绑定付费服务，缺能力就记录实际缺项，不能自动调用 GD CLI。需要重型补全/整图拆层时显式选择合适后端，不把 skill 本身当分割模型。不确定的远程调用查询原 task/invocation，不新建假ID。

写 external-assets.json（或 agent-assets/response.json），详见 agent_assets.py：

```json
{"schema_version":1,"token":"来自asset request","plan_sha256":"来自asset request","assets":[{"id":"subject","path":"assets/subject.png","sha256":"真实文件哈希","origin":"ai","tool":"实际工具","provider":"实际服务","model":"实际模型","task_id":"真实服务任务ID或null","invocation_id":"没有服务端任务时的真实DSH调用ID","input":{"prompt":"原始完整输入"},"status":"completed","evidence":[{"path":"evidence/tool-response.json","sha256":"真实文件哈希","kind":"tool-response"}]}]}
```

AI 必须保存真实截图/原始工具响应，程序原创保存源码/执行记录。空计划也需同 token、plan_sha256、schema_version 的空 assets 响应。路径必须在本 concept 内，哈希、透明度、计划覆盖与版权分类均验证；不能拿另一张已完成任务替代。来源索引不等于版权证明，也不代表审核通过。

纯文字/程序形状任务可在01-creative时一并写齐各候选原生recipe。总控只对冻结空素材计划、完整纯原生候选并经过素材校验的情况自动写真实空回执，省去02-assets交接；缺配方或存在外部图片仍正常交接。不得跳过03-layout实际看图。

同时写各候选原生 recipe。总控用同一文字渲染器低成本生成全部预览（多画板逐页，不叠页），不生图、不打PSD、不上传。`03-layout` 实际看所有方案和每页，比较缩略图层级、对齐/留白、自然换行、字体搭配、整体配色、主体边缘和用途。响应增加 `selected_id`，并写具体观察。弱稿要修正输入并保留旧修订，不能为赶流程假通过。选定的本地预览保存 master.jpg，明确它是构图参考而不是AI母稿。

### 构建、浏览器登记与编辑器验收

`build` 生成独立 PNG、原生文字PSD、图层表及材料包。`05-register` 为浏览器登记交接：

- 读取 release/registered-assets/request.json，先查当前真实库和已有上传，再上传精确的最终PNG；不确定先恢复，不重传。每层标题含内容哈希。
- 写 release/registered-assets/response.json：`{token,assets:[{id,layer,title,sha256,category,asset_id,repository_id,state:"verified",url,evidence:{path,sha256}}]}`；evidence路径相对 release，必须是真实重新打开后的浏览器截图。
- 程序检查覆盖数量、唯一实际ID、内容哈希、分类和证据。Agent 对实际库和图像负责，不能编造ID或截图。

浏览器登记优先一次调用 `browser register-assets 配方 --space 当前ID --page 实际专用DAM页标签`，助手产出回执后实看登记图完成门审查，不重复手写上传脚本、查询或哈希。助手保留一次真实库重开，已有asset_id在首屏且DOM可见时批量核实，原图最多3项并发下载，缺失项回退UI查找；新上传保持串行和pending防重发。

该命令：真实UI查询哈希标题后上传，先持久绑定当前库，下载原图核验SHA；未知pending只恢复核实、不重传。省略库ID时不改冻结请求，实际绑定写入独立状态。

随后本地生成来源索引、原创程序记录；导入PSD，逐层通过真实font-id原生点击、checked状态与控件预览核实字体；云保存后重开原作品再次逐层检查。旧font-verification名称清单不能跳过检查。逐层替换绑定真实 DAM 素材。不要一边登记一边并发改同一编辑器页面。`layer_audit` 逐对隐藏主体/背景再恢复和刷新，失败自动恢复；`recovered-needs-review` 必须实看恢复图后重跑。

`04-final` 前总控生成 `release/review-packet/agent-summary.md` 简明输入、`manifest.json` 完整明细和本地HTML索引，统一列出真实截图、来源证据、内容哈希与缺项，并提供 `passed:false` 审查草稿。也可运行 `review-packet 配方` 重新生成。索引不是证明、更不代表审查通过；正式review和gate必须由Agent在实看原图后填写。制作阶段同步保留源码、执行日志及真实截图，避免最后临时补证据。

`04-final` 打开全部隐藏/恢复/编辑器截图，对照选定构图，确认独立完整背景、无烘焙主体副本、文字可编辑、字距行距、字体、裁切与来源。写 visual-review.json（passed、spec_sha256、checks）和 material-review.json（passed、bindings_sha256、evidence_sha256、checks）。

版权证据写 concept/copyright-evidence.json：`{categories:{original:[{path,sha256,layers:[所覆盖ID]}],original_ai:[...]}}`，路径相对 concept。必须覆盖每个图片层；AI真实截图展示工具、完整prompt、模型、结果及必要参考输入；程序/照片提供实际过程或原照片证据。receipts.png 与 shape-evidence.png 是生成的索引，**禁止当平台证明上传**。证据清单哈希必须进入 material-review。

之后 `copyright_and_form → submit → complete_declaration → reopen_verify → package`。新总控将稳定浏览器步骤按两段串行批量执行，每段只启动一次 ego-browser nodejs，同一 TaskSpace/Page 内复用现有函数：

```text
browser-batch prepare,bind,audit 配方 --space 实际ID --page 实际编辑器页
browser-batch form,submit,declare,verify 配方 --space 实际ID --page 实际编辑器页 --final-review-gate 本run/gates/04-final
```

两段之间保留 04-final 的真实视觉审查，不允许组合跨越它。命令打开浏览器前先做 publication_preflight，发布段每步复核 gate 与当前文件哈希。不得用批次日志标记步骤成功或跳过操作；旧已开始的单阶段任务继续使用原检查点恢复。发布成功后版权步骤失败时，只有 publication.json 明确 published:true、有效阶段且标题/话题/描述匹配当前稿件，才跳过重新开表单并走既有 submit 幂等分支，再执行声明和核验；submission-started 不确定仍停止，不自动重发。

总控写 browser-sequence.jsonl，记录每步开始/成功/失败、单调时钟耗时、尝试ID；timing-report.json 的 browser_steps 汇总失败和重跑，未结束步骤的时长保持未知。这些耗时已包含在原 machine spans 中，不再与总墙钟重复相加，也不推断其中模型思考、网络或人工等待的占比。单阶段 browser 命令仍保留供旧任务和定向恢复使用。

真实的引用证据、请求和来源清单一起进入材料包，不仅交付一张索引图。审核中不等于上线/通过。

## 配方与排版

recipe 有 `canvas:{w,h,dpi?},topic,title,description,layers,layer_audit:{pairs:[{subject,background}]}`。每层 id/name 唯一、box:[x,y,w,h]。图片 type:image、source、真实copyright_category；透明主体 require_alpha:true。形状 type:shape、color、copyright_category:original，可 rectangle/ellipse/polygon/blur；简单图形先本地绘制。文字 type:text、text、size、color(RGB)、明确 font（PSD名称）、preview_font（系统文件）、gd_font（稿定实际可用字体）。各信息项独立层。

文字 align:left/center/right（默认left）、line_height字号倍数（默认1.25）、letter_spacing像素（默认0）、stroke:[[r,g,b],整数像素宽]贯通预览和PSD。不可靠伪造字重代替字体。暂不支持非零rotation、复杂文字非零逐字距和未实现文字效果；明确报错，不默默变样。文字溢出报错。PSD的真实文字像素缓存仍位于同一可编辑文字层，不增加图片层；稿定导入后的重新排版仍需实看。

多画板用 pages:[{id,name,canvas}]，每层显式page，ID/name全稿唯一；各页PSD导入同一作品，登记和版权覆盖全部画板。图层名语义化，layer_audit覆盖每个主主体与背景/主要独立物件，不用多余图层凑数。

## 版权入口、状态与交付

2026-11-06 实测声明入口：我的 → 发布 → 卡片右下角「…」→「版权认证」。编辑器右上角「版权说明」不是声明面板。未分类0、各分类图数与登记表一致、每类真实证明齐全，勾确权声明后发布，并从发布管理重新打开确认只读分类和材料仍在。入口统一复用 copyright.js:openPanel。

gate/request.json 包含输入哈希、token及要求。实际观察并完成指定文件后，原子写 response.json（passed:true、正确token、具体checks，阶段需要的selected_id/action）。输入变化旧响应失效，先保留旧修订再重新审查。不能凭文件存在、工具成功或图层数量通过。

完整交付须包括 results.json、作品链接/contentId、真实审核状态、PNG/PSD/ZIP、图层表、配方、构图预览、登记/绑定记录、原始来源证据、版权重开核验和分层截图。timing-report.json 包含 Agent 等待和修复的实际墙钟时间；不要用单次运行承诺速度/费用节省比例。已保存 published:true 不重复发布；submission-started不确定先核对真实发布管理。修复已有稿保留原contentId。
