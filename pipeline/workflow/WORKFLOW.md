# 从话题研究到完整投稿

这是当前执行规范。总控推进确定性步骤；Agent 负责研究、完整 prompt、素材修补决策与实际看图验收。`auto` 会投稿，仅在用户授权投稿后运行。

## 安装与运行路径

DSH 首次调用 `gaoding_topics` 读取技能、路径和依赖状态。`gaoding_workflow` 参数 `["bootstrap"]` 安装锁定的 Pillow、ag-psd、pngjs；用 `["status",返回的directory]` 等待退出码为 0，再调用 `["doctor"]` 并等成功。所有非 status 命令后台执行，工具返回不代表完成。

GD CLI、ego-browser、Node、npm、Python 必须由用户环境提供；不会随插件安装。当前只验证 macOS，预览与证明图使用系统中文字体。`doctor` 包含参考图编码回归；CLI 升级后若失败先诊断，不能跳过或自动覆盖全局包。见 `../fixes/README.md`。

源码运行可直接使用根目录 `workflow.sh`；默认依赖在 pipeline。插件运行数据默认 `~/.local/share/dsh-gaoding-publisher`：`runs/`、`subscriptions/`、`research-cache/`、`dependencies/`、`operations/`。工具返回路径为准。`GAODING_DATA_DIR` 指定数据根目录，`GAODING_RUNTIME_HOME` 指定依赖目录；`GAODING_WORKSPACE` 仅供开发显式切换源码。

## 启动与恢复

使用 ego-browser 技能建立一个 TaskSpace，确认 p1 页面；查询当前账户真实 DAM 库 ID，不复制历史账号。已选题直接用返回 key 登记 `gaoding_subscribe`，随后逐个执行返回的 args。

```text
gaoding_workflow args=["auto","绝对运行目录","--topic","tour","--space","本次ID","--repository-id","当前库ID","--watch"]
gaoding_workflow args=["status","同一绝对运行目录"]
```

随机抽题仅在用户要求时省略 `--topic`。选题、空间和库一经记录，续跑参数必须一致。同目录的重复活动启动返回已有状态，不会重发。`--watch` 在后台等待 Agent；不要重复启动来推进 gate。退出后只在明确恢复原因时用原参数续跑。启动记录不确定时先核查 PID、日志和 run.json；不得直接删锁、删任务回执或伪造 done。

一个目标仅用一个 TaskSpace；多个话题顺序执行。总控仅并行相互独立的分层调用，以及登记、来源证明、编辑器准备。图片生成任务一旦存在 taskId 就查询原任务；submission-started 不确定时禁止重复投稿。

## 阶段与 Agent 验收门

1. `research_collect`：实际进话题详情页，保存 TOP1–TOP3 和列表前七张、来源、截图、完整规范、规范图片。不是完整前十排名时如实描述。缓存按内容哈希校验，实时来源变化则失效。
2. `01-creative`：实际打开十张图和规范示例，分析面积比例、阅读顺序、景深、遮挡、图片组成、文字层级、光向、材质、用途及原创迁移原则；标记重复系列。写 `research/analysis.md` 和 `research-review.json`（`passed:true`、`samples` 十条具体分析）。缓存命中也复核当前规范，只复用研究，不复用旧 prompt。
3. 写 `research/creative-brief.json`，本轮恰好一个方向。`research` 包含 `sources:"sources.json"`、`analysis:"analysis.md"`；`concepts` 中每项必须有安全目录 `id`、`concept`、`reading_path`、`zones`、`depth_plan`、`lighting_material`、`copy`、`layers`、完整 `master_prompt`、`width`、`height`。详细字段以 `../generate_masters.py:prepare` 为准。prompt 必须由 Agent 独立写全，不能代码拼接或套固定坐标。研究图不附到生产请求。
4. `02-master`：看实际母稿，检查构图、文案、人物脸手、信息密度、材质和可分层性。弱视觉不能通过。需要重做时保留原任务记录，新请求用新目录，先修正流程输入再续跑。
5. `parallel_split`：布局分层与智能分层并行，每个任务独立保存请求、taskId、结果和资源。自动结果不能直接当成成品。
6. `03-materials-NN`：逐张检查透明像素、人物边缘、文字是否烘焙、背景是否完整、是否残留第二个人物。人物与黑色场景必须分开且背景不能缺失。Agent 写 `release-recipe.json`；合格响应 `action:"build"`。需修补响应 `action:"repair"`、`jobs:[{id,directory,tool,input,localize?}]`，使用公开 CLI schema，精确修补有问题的素材，再进入下一轮验收。
7. `build` 生成独立 PNG、PSD、原生文字及素材包；`parallel_prepare` 登记 DAM、准备来源证明、导入编辑器并验证字体；`bind_assets` 将每个图片层绑定真实 DAM 素材。
8. `layer_audit` 逐对隐藏主体/背景，再恢复并刷新确认；原透明度先持久化，失败自动恢复。若中断恢复为 `recovered-needs-review`，必须实看恢复截图后重跑，不能标成功。
9. `04-final`：看每张隐藏截图、刷新恢复图、每画板编辑器图并对照母稿；检查层的独立性、透明边缘、文字可编辑、字体、裁切、间距与来源。写 `release/visual-review.json`（`passed:true,spec_sha256,checks`）和 `material-review.json`（`passed:true,bindings_sha256,checks`），哈希必须来自当前文件。不能凭文件存在或图层数量通过。
10. 总控继续 `copyright_and_form → submit → complete_declaration → reopen_verify → package`。所有图片先登记、绑定再声明，图片层数必须等于候选数量。AI 来源用 `original_ai`，程序绘制用 `original`；分别上传真实证明。重新打开发布管理和版权面板检查保存结果。审核中、审核通过、审核不通过按实际显示，不混称。

每个 gate 的 `request.json` 给出当前 token、输入哈希和要求。完成实际观察与指定文件后，原子写 `response.json`，包括 `passed:true`、相同 `token`、具体观察的 `checks`，以及该阶段要求的 action。失败就记录具体原因，不写假的通过结果。输入变化后旧响应必须归档重审。

## 配方与可编辑性

配方字段为 `canvas:{w,h}`、`topic`、`title`、`description`、`reference_master:"master.jpg"`、`layers`、`layer_audit:{pairs:[{subject,background}]}`。pairs 用图层语义名称，覆盖每个主要主体与背景/主要独立物件。

每层 `id`、`name` 唯一，`box:[x,y,w,h]`。图片提供 `type:"image"`、`source`（相对配方）、真实 `copyright_category`；透明主体加 `require_alpha:true`。形状提供 `type:"shape"`、`color`、`copyright_category:"original"`，可用 polygon/ellipse/blur。文字提供 `type:"text"`、`text`、`size`、`color`、PSD `font`、系统 `preview_font` 与稿定 `gd_font`；标题、日期、场馆、各档价格分别成层。

多画板加 `pages:[{id,name,canvas}]`，每个 layer 带 `page`，全稿层名和 ID 唯一。每画板导出 PSD、导入同一作品，登记及版权计数覆盖全部画板。

背景必须独立且完整；不能把整张照片当人物层。合成效果须接近母稿，不能为了增加层数而降低视觉质量。规范要求以本次网页为准，不机械填历史活动字段。

## 错误与交付

`status` 返回真实 run、gate、日志与进程状态。已观察到发布成功并保存 `published:true` 的 submit 再执行只返回原记录，之后继续声明/核验，不再次点发布。成功回执尚未记录的 submission-started 需要核对发布管理后恢复，不可猜测。

`complete` 必须包含 `delivery/results.json`、素材 ZIP、PSD、独立 PNG、图层表、配方、母稿、登记/绑定记录、真实任务及原创证明、版权保存核验与分层截图。报告 contentId、作品链接、审核状态、图片/文字层数、素材包路径和 `timing-report.json` 的实际墙钟耗时（包括 Agent 等待和修复）。

历史样例在仓库 archive 中，只供追溯；安装包不含它们。不能从旧案例拷贝坐标、账号、绝对路径或发布状态来运行新稿。
