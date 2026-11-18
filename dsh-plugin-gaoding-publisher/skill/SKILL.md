---
name: gaoding-publisher
description: 制作稿定可编辑模板、按实时话题投稿或恢复已有任务。默认本地原生排版、独立素材、DSH图像能力与浏览器登记，不依赖GD CLI。仅预览不能自动投稿。
---

# 稿定原生分层制作与投稿

先调用 gaoding_topics，读取返回的完整 guide 和 workflowGuide。路径以工具为准，不猜机器目录、账号或历史空间。目录源为创作者中心灵感页；按钮每次打开实时刷新，显示完整性/数量/时间。不要把语雀教程或历史五项当全部话题。

用户已选题、全部或明确授权随机时直接执行，不重复询问。随机须从当前完整可参与目录抽取一次并记录，随后冻结该题快照；不能省略native选题而落入旧五题池。只请求生成/预览时使用手动 preview/build 阶段，不运行会投稿的 auto。

1. 复用 gaoding_topics 返回的 space 作为本目标唯一 TaskSpace；若已有当前空间则传 {space:实际ID,refresh:true}。目录读取临时页不覆盖编辑器。catalog不可用/过期先恢复实际页面，不能宣称已完整刷新。缺链接话题保留，但研究无法找到唯一规范和样例入口时说明具体缺项。
2. 首次 bootstrap 后用status等退出0，再doctor。默认不需要GD CLI，只依赖ego-browser、Node/npm、Python和本地Pillow/ag-psd。插件不安装或覆盖全局工具。
3. gaoding_subscribe 接收目录返回key和同一space；repositoryId仅在已经查到真实当前ID时提供，可以省略，浏览器登记阶段再取。按返回jobs.args串行启动，参数含 --topic-json、--mode native、--registration agent。所有非status命令后台立即返回，用status查看；启动不代表完成。
4. 默认 native：实际研究十图与完整规则 → Agent一个创意方向和2–4套本地版式/配色方案 → 独立素材交接 → 真实看全部预览选优 → 原生文字PSD/PNG → 浏览器登记 → 编辑器导入/字体/绑定 → 隐藏恢复验收 → 按授权投稿及版权重开核验 → 完整素材包。
5. waiting_agent 时读gate/request.json及工作流手册，按真实证据写分析、brief、素材回执、recipes、视觉/来源审查，再原子写正确token、passed和具体checks；版式门另写selected_id。程序不拼接prompt，不复制旧坐标，样例只研究、不用作生产素材。
6. 图像优先现有DSH插件/本地工具按层制作；文字与简单图形本地原生生成。复杂抠图/补全需真实模型，skill自身不是分割模型。缺后端就说明实际缺项，不静默调用GD CLI或发起未授权付费任务。不确定任务查询原task/invocation，不能重发、制造任务ID或回执。
7. 纯文字/程序图形稿可在01创意交接中一并写齐2–4套实际配方，减少后续空素材交接；总控只在冻结计划为空、配方完整且校验通过时自动生成空素材回执，03版式看图门仍保留。外部图像必须有可验证的external-assets.json（schema_version/token/plan_sha256、资源哈希、实际tool/provider/model/input、真实task_id或invocation_id及原始工具响应/截图）。程序原创保存真实源码/执行记录。空素材计划也回传相同token的空assets。具体契约读agent_assets.py和workflowGuide。
8. 浏览器登记依照release/registered-assets/request.json，优先一次调用browser register-assets及手册中的真实UI助手；在同一空间的专用DAM页执行，不覆盖编辑器页。助手生成真实回执后，Agent实看登记截图并完成门审查，不手工重复查询和重写哈希。先查真实库和已有上传，再上传精确最终PNG，下载原图核验SHA，保存实际asset_id/repository_id及重新打开截图，回写response。省略库ID时先持久绑定实际库而不改冻结请求。禁止猜账号/历史ID、重复不确定上传，禁止用占位值满足程序检查。
9. 母稿在native模式是选定的本地构图预览，不能称AI生成。人物、完整背景、主要物件独立；标题/日期/场馆/价格是原生可编辑文字。实看所有画板、透明边缘、隐藏图和刷新恢复图，不以图层数替代质量。确认字距/行距/对齐/描边在导入后仍正确；字体必须原生点击真实font-id并检查checked及控件预览，云保存后重开逐层核验，不能凭旧名称回执跳过；不可靠效果会显式报错。
10. 最终审查优先读取自动生成的release/review-packet/agent-summary.md，按需查manifest.json详情，按清单实看实际原图，使用passed:false草稿准备审查；缺失/陈旧证据要补齐后重建review-packet，禁止把自动清单当审查通过或版权证明。制作时同步保存真实源码、执行日志与过程截图，减少最后补证据。所有最终图片登记并替换绑定；图片层数必须等于版权候选数，original_ai/original按真实来源分类。版权上传必须使用真实截图/原照片：copyright-evidence.json给path/sha256/覆盖layers，并将其哈希写入material-review.json。receipts.png和shape-evidence.png仅是程序生成索引，不能冒充平台证明。重新打开声明面板确认保存，审核中不等于通过。
11. 失败读日志、原任务和真实平台状态，保留记录，不手改run.json或删除锁绕过。已发布稿只补声明/核验，不重复投稿；修复已有稿保留原contentId。普通话题只添加精确话题标签，不能强制参加无关活动；含AI开关按实际图片来源核验，程序原创不标AI。旧空间确已消失时遵守ego-browser技能取得用户新空间授权，再用recover-space命令核实并记录原作品恢复；不得自动新建避错。完整交付作品链接、实际审核状态、图层数、PNG/PSD/ZIP及包含等待/修复/调试/暂停的墙钟耗时。

旧run无mode字段仍按原GD CLI路径恢复，不在中途切换。只有显式选择 --mode gd-cli/--registration gd-cli 才使用兼容CLI；doctor --legacy-cli才检查它。不把旧路线作为native失败的自动回退。
