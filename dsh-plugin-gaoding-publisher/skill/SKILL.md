---
name: gaoding-publisher
description: 制作稿定可编辑话题模板、按话题投稿，或续跑已有稿定生产任务时使用。研究详情页十张样例，由 Agent 写原创 prompt，完成母稿、独立分层、PSD、DAM 绑定、投稿、版权声明及交付。仅预览任务不能自动投稿。
---

# 稿定话题制作与投稿

先调用 `gaoding_topics`，读取返回的 `guide` 和 `workflowGuide`。路径由插件提供，不能假设机器目录、账号或历史 TaskSpace。缺插件工具时，先定位当前项目的 AGENTS.md 和 workflow.sh，读手册后使用等价 CLI，不从旧笔记猜路径。

用户已选话题、选择全部或明确要求随机时直接执行。未选时才列话题让用户选；已有投稿授权不反复确认。只请求生成/预览时使用手动阶段，不运行会投稿的 auto。

1. 依赖未安装：`gaoding_workflow {args:["bootstrap"]}`；随后用 `["status",返回的directory]` 等待退出码 0，再运行 doctor 并确认通过。GD CLI 和 ego-browser 使用全局安装、当前用户登录，不由插件改写。
2. 使用 ego-browser 技能创建/复用本次 TaskSpace，确认 p1；查询当前 DAM 库 ID。指定话题调用 gaoding_subscribe 并传真实 space/repositoryId，逐个用返回的 jobs.args 启动。随机授权时在 dataRoot/runs 下建立新目录，auto 不传 --topic，选定后不重抽。
3. 工作流非 status 命令均立即返回后台任务。用 `["status",directory]` 查看状态，不把启动当完成；有运行进程时不重复启动。多话题串行，同一目标一个浏览器空间。
4. waiting_agent 时读取 gate/request.json；实际看图完成其要求，写分析、brief、配方、视觉/素材审查文件，再原子写含正确 token、passed、具体 checks 的 response.json。03 阶段还需 build 或 repair 的 action。总控自动继续，无需手改 run.json。
5. 失败时读日志、任务回执和实际平台状态。已发布稿只补声明和核验，不重复投稿；不确定状态先调查。不能删除失败记录后重来，不能直接改 done 绕过验收。
6. 完整运行到版权重新打开核验和 package。交付作品链接、contentId、真实审核状态、图片/文字层数、素材包与包含等待/修补的实际耗时。审核中不等于通过。

必须实看详情页 TOP1–TOP3 与列表前七张及完整规范，标记重复系列；图层组成只能描述为视觉推断。Prompt 由 Agent 基于本次研究完整写作，程序不拼接，不复制旧方案。研究图不作为生产素材。

母稿、分层、编辑器均需实际视觉验收。人物与完整场景背景、主要物件和信息容器独立成层；文案为独立原生文本。看隐藏图和刷新后的恢复图，确保黑色背景没有丢失、没有烘焙主体副本。不以图层数代替可编辑性。

所有最终 PNG 登记 DAM 并替换绑定。图片层数必须等于版权候选数；original_ai/original 按真实来源分类，分别附真实证明，重新打开核验保存。素材为空、面板缺失或 not_offered 不算完成。
