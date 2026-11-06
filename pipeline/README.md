# 运行内核

统一入口为上一级 `workflow.sh`。当前执行规范只有 [workflow/WORKFLOW.md](workflow/WORKFLOW.md)。

`workflow/orchestrator.py` 管理阶段、缓存和 Agent 验收门；`jobs.py` 保留付费任务状态；`parallel.py` 管理独立任务依赖；`layer_audit.js` 管理独立图层隐藏及恢复验收；`publish.js`、`copyright.js` 管理投稿与版权声明。

旧固定提示词、固定坐标生成及单稿修补脚本已删除。历史数据在根目录 `archive/` 和其中索引的原 DSH 目录，不作为新任务输入。
