# GD CLI 参考图编码兼容性

此处保留 2.1.0 参考图数组编码补丁与离线回归。它是兼容记录，不表示当前 npm latest 或其他版本都需要此补丁。

`test-reference-wire.mjs` 通过 PATH 定位全局 @gaoding/cli，模拟传输，检查服务端参数形态为 JSON 字符串时数组是否正确编码，同时验证显式 prompt 未被覆盖。它不发起付费生成。

```bash
node pipeline/fixes/test-reference-wire.mjs
```

当前机器的 2.1.0 已应用过修复。重新安装或升级后先运行 doctor；若失败，核对该版本真实适配器与当前公开 schema，再决定适用修复。bootstrap/doctor 不修改全局 CLI，补丁不自动执行。历史成功任务及前后图保留在 archive 索引指向的旧工作区。
