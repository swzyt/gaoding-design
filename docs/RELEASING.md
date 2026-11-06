# DSH 插件打包、安装与验证

包名 `dsh-plugin-gaoding-publisher`。唯一源码为本仓库 pipeline/tooling 和插件目录；runtime 是生成物，禁止手改。遵循 [DSH 官方打包指南](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md) 的 bundle patch 与 profile 安装机制，不手写用户 profile manifest。

## 构建

1. 更新插件 package.json 版本，运行 `bash scripts/check.sh`。
2. 仓库根运行 `mkdir -p dist`，再 `npm pack ./dsh-plugin-gaoding-publisher --pack-destination ./dist`。prepack 从白名单复制运行文件，包含运行依赖锁文件，不包含已安装依赖、用户资料、历史素材或凭证。
3. 运行 `node scripts/verify-package.mjs dist/dsh-plugin-gaoding-publisher-0.3.3.tgz`，验证解包运行、CommonJS 模块边界、运行源码哈希和禁入文件。
4. 记录 `shasum -a 256 dist/*.tgz`，把验证结果留在 docs/VALIDATION.md。

## 独立 profile 测试

用临时 DSH_HOME 和测试 profile 安装 tgz，不复制正式 profile 配置或凭证：

```bash
DSH_HOME=/absolute/temporary/dsh-home dsh plugin --profile gaoding-test add /absolute/path/package.tgz
DSH_HOME=/absolute/temporary/dsh-home dsh --profile gaoding-test --dump-config
```

检查 bundle 层、元数据、实际安装内容。桌面版 `desktop` profile 由 Electron 应用独占管理，CLI 会以 "profile "desktop" is managed exclusively by the Electron application" 拒绝；正式启用必须在 DSH 内用 Plugin Manager 安装 tgz。已经加载的同包版本更新需刷新或重启。不要通过手改 profile YAML 或 symlink 模拟安装。

工具注册使用宿主支持的原始 JSON Schema 子集（`type` 只能是 object/array/string/number/integer/boolean/null，或省略 type 的纯 annotation schema），`{ type: 'json' }` 和 `defineTool` 的 spec 写法（`{ required: true }`）会导致激活失败；改动工具定义后先用宿主 `@deepseek-ai/dsh-tools` 的 `assertSupportedJsonSchema` 验证再打包。

还需在真实 DSH UI 检查“投稿”按钮、选题消息、gaoding_topics 注册、bootstrap/doctor、Agent 能响应后台 gate。界面未实测就不能声称完成 UI 验收。付费生成与真实投稿属于生产验证，必须有相应授权；离线测试不能代替视觉和版权实测。

## 运行约束

只声明 macOS 支持，字体证明依赖系统字体。工具用 PATH 找全局 GD CLI/Node/npm/ego-browser；桌面 DSH 的 PATH 需能找到这些程序。账户及 DAM ID 不进入源码。用户数据保留在独立 dataRoot，升级/卸载 npm 包不删除证据。

当前参考图回归针对已验证的 GD CLI 2.1.0 内部适配器；升级或原装版本回归失败时停止生产并诊断，不自动修改全局安装。不要通过删除该检查来发布。

## 公共发布

当前只构建可安装 tgz，没有执行 npm publish。准备公开发布前，维护者决定 registry/包名归属和许可证；当前 UNLICENSED 不代表已开源。配置好归属后发布已验收的同一个 tgz，避免再次打包得到另一份代码。npm tarball 安装无需构建脚本；依赖由显式 bootstrap 安装。
