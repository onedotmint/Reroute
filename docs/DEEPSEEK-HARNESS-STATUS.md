# DeepSeek Harness 接入状态检查点

**状态：WIP 预览，尚不可正式启用或用于付费任务。**

分支：`feat/deepseek-harness-preview`。基于主分支 `d24081d`；本次仅保存开发状态，不合并主分支、不发布 npm、不创建 Release，包版本仍为 `0.4.1`。提交使用 `[skip ci]`，按用户要求暂不触发完整 CI。

## 已完成

- 同一个 Reroute 包新增 Harness `./dsh` 入口、bundle 声明与安装 patch，保留 Pi。
- 提取共享工具执行/状态逻辑，保留命令限制、项目 consent、输出边界和 receipt 语义。
- Harness 原生 `reroute_run` / `reroute_status`、逐次审批、本地文件映射及可信项目发现上界。
- 取消时原生文本保留已分配 Job ID；`reroute_status({})` 在当前 live Session 找回最近任务。
- 显式插件卸载取消并等待自有工作；不接管 Bash、不添加后台任务或新设置面板。
- 使用说明和工程规格已补充。

## 已通过的针对性验证

环境：Linux / Node `v24.22.1`，现有 DeepSeek Harness `0.2.1-rc.5`；没有真实模型或云 Provider 调用。

| 命令/检查 | 结果与边界 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm run build` | 通过 |
| `node --test tests/pi-status.test.mjs tests/pi-authorization.test.mjs tests/config-boundary.test.mjs` | 24 项通过 |
| `node --test tests/pi.test.mjs tests/global-config.test.mjs` | 35 项通过，包含真实 Pi 源码加载和真实引擎/mock Provider |
| `node --test tests/dsh.test.mjs` | 36 项通过，真实 Harness SDK、Session fixture 与真实引擎/mock Provider；不是完整模型 Agent loop |
| `node --test tests/dsh.integration.mjs`，指定现有 DSH/本地 pnpm | 1 项通过：真实当前 tgz 安装、原生/PTC 调用、卸载；打包集成只走拒绝与状态路径，未启动 Provider |
| scoped AFT diagnostics / `git diff --check` | 已检查代码诊断与空白；不代表全套测试通过 |

安装集成从现有安装运行，示例：

```bash
REROUTE_TEST_DSH_ROOT=/absolute/path/to/node_modules/@deepseek-ai/dsh \
REROUTE_TEST_PNPM=/absolute/path/to/pnpm-native \
node --test tests/dsh.integration.mjs
```

SDK 来自宿主而非在 profile 内另装一份；安装/卸载均在临时 HOME/DSH_HOME 中完成，真实用户 profile 和凭据配置未改。可复现测试已提交；本机原始 JSON 证据在忽略目录 `.artifacts/dsh-integration.json`，不属于 Git 分支内容。

该测试 tarball 的实现候选在最终文档收尾之前构建，版本号不是源码身份：

```text
onedotmint-reroute-0.4.1.tgz
sha512-W2zJ6U73ARHr94RXm6vNikBAwJz6//1irMYIQsJ2hMdVmcFWP8cZd5/BW4bMgMCKju8qj4qryYE5zrd4AvAYJw==
```

## 必须先修复的已知问题

### P1：审批等待中的配置/预算变更

`src/tools.ts` 在审批前加载项目配置并决定路由，`src/dsh.ts` 的审批后检查没有重新加载配置。等待期间切换 `mode=local`、撤销 managed 授权或收紧预算，仍可能把旧配置交给引擎；私有项目 consent 不因这些字段变化自动失效。

下一步：在原可信 boundary 内重新发现 root、加载配置；发现 root 或执行相关配置变化则拒绝本次调用，要求重新提交审批，不能静默执行新目标。补配置/预算变更的窄测试。

### P2：审批等待中切换为 `policy=never`

固定版本的审批 SDK 在进入 answerer 前读取策略；等待期间切到 `never` 后，旧 answerer 的 `allowed-once` 仍可能被接受。适配器未在交给核心前重查当前有效审批策略。

下一步：审批返回后再次检查有效策略，`never` 必须拒绝；补等待期间策略变化测试。

**上述问题在本检查点仅记录，尚未修复。现有通过测试没有覆盖它们，不应把通过数理解为安全验收完成。**

## 其他未验证项

按用户要求，这次**没有运行完整 `npm test`、完整 clean-consumer 打包检查或全套 CI**。也没有新增真实模型工具选择、付费云、标准 Web/Desktop UI、Windows、冷进程重启及网络故障验收。

PTC 安装集成证明了结构化调用和拒绝路径，但**尚未端到端验证 PTC 中已分配 Job 后取消，再用 `{}` 找回的完整桥接**；原生组件测试不能替代这项。插件重载/进程重启后，省略 Job ID 的映射会丢失，需使用现有持久 receipt 的显式 ID。

建议恢复开发顺序：先关闭 P1/P2 → 补 PTC 取消恢复桥接 → 获准后完整回归/打包门禁 → 再决定真实模型与云端验收及版本发布。

更多设计与使用约束见 [使用说明](DEEPSEEK-HARNESS.md)、[调查记录](DEEPSEEK-HARNESS-FEASIBILITY.md) 和 [工程规格](../specs/engineering/harness-tool-ownership.md)。
