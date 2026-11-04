# DeepSeek Harness 接入状态检查点

**状态：WIP 预览，尚不可正式启用或用于付费任务。**

分支：`feat/deepseek-harness-preview`，已合并回主分支并以 **0.4.2** 发布。检查点 `2b1914c` 保存 P1/P2 修复和 PTC 取消恢复验证；0.4.2 只是把该适配器随包分发，**不代表已完成验收**，仍为 WIP 预览。以下内容是发布前的检查点记录，版本号和 tarball 名称保留原样，不是 0.4.2 的重新测量。

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
| `node --test tests/dsh.test.mjs` | 当前工作区 51 项通过（新增 15 项审批等待回归）；真实 Harness SDK、Session fixture 与真实引擎/mock Provider，不是完整模型 Agent loop |
| `npm run test:dsh`，指定现有 DSH/原生 pnpm | 当前实现重打包安装/原生/PTC/卸载 1 项通过（拒绝/状态路径，无 Provider）；另有真实 Node PTC 取消恢复桥接 2 项通过（checkout adapter + 真实引擎/mock Provider） |
| scoped AFT diagnostics / `git diff --check` | 已检查代码诊断与空白；不代表全套测试通过 |

本轮重新通过类型检查、构建、上述 59 项 Pi/config 测试和 51 项 Harness 测试。新增 15 项测试中，14 项在旧实现上复现失败，另 1 项验证仅 JSON 键顺序变化仍可执行；修复后全部通过。AFT scoped diagnostics 为零错误/警告。这些测试未调用真实模型或云资源。

安装集成与 PTC 取消恢复均使用现有安装运行，成功环境另含原生 pnpm `12.16.1`，示例：

```bash
REROUTE_TEST_DSH_ROOT=/absolute/path/to/node_modules/@deepseek-ai/dsh \
REROUTE_TEST_PNPM=/absolute/path/to/pnpm-native \
npm run test:dsh
```

SDK 来自宿主而非在 profile 内另装一份；安装/卸载均在临时 HOME/DSH_HOME 中完成，真实用户 profile 和凭据配置未改。安装集成的可复现测试已在先前检查点提交，新增 PTC 取消恢复测试随本次提交保存；本机原始 JSON 证据在忽略目录 `.artifacts/dsh-integration.json`，不属于 Git 分支内容。

该检查点实际重新打包并通过安装验证的 tarball 如下（含 P1/P2 实现修复）；它在提交前从非干净工作区构建，不是提交的精确打包产物，也不是发布或完整 clean-consumer 验收，版本号不是源码身份。0.4.2 的独立打包校验见 [0.4.2 发布说明](RELEASE-0.4.2.md)。产物和安装结果位于忽略目录 `.artifacts/onedotmint-reroute-0.4.1.tgz`、`.artifacts/dsh-integration.json`：

```text
onedotmint-reroute-0.4.1.tgz
sha512-le2eR/go4WMP/Owa0sRq/sS0LMQc61823373sV95jWeUvEOQqPb07fbxD5SMR5QaeuPCiERWJmvSbwzn+2SkvA==
```

## 已修复的审批等待问题（当前工作区）

### P1：审批等待中的配置/预算变更

旧实现仅在审批前加载项目配置；审批后即使切换 `mode=local`、撤销 managed 授权或收紧预算，仍可能把旧配置交给引擎，且这些变更不一定使私有项目 consent 失效。

现于 `src/dsh.ts` 审批返回后，在原可信 boundary 内重新发现 root 并加载有效配置。root 或有效配置变化则拒绝本次调用，要求重新提交审批，不静默执行新目标。使用标准库深比较，JSON 对象键顺序变化不触发拒绝；比较整个有效配置，非活动 profile 的变化也会保守拒绝。不改共享执行层或 Pi。

回归覆盖本地模式、路由限制、任务类别、超时、目标镜像、managed 授权、单任务/月预算、全局继承配置、root 变化、配置删除/损坏，以及键顺序不变语义对照；拒绝路径均未进入 executor、未分配 Job。

### P2：审批等待中切换为 `policy=never`

固定版本 SDK 在进入 answerer 前读取策略，等待期间切到 `never` 后仍可返回旧 answerer 的 `allowed-once`。

现于审批后完成配置和 consent 检查，再按 SDK 的优先级读取当前策略（Session override → service default → `ask`），仅当前策略为 `ask` 才放行。两项回归分别在真实 pending 审批期间更改 Session 策略和 service 默认策略，验证迟到的 `allowed-once` 均不能开始执行。

**P1/P2 的针对性修复与回归已完成，不等于完整安全/发布验收完成。**

## PTC 取消恢复桥接验证

新增 `tests/dsh-ptc.integration.mjs`，由 `npm run test:dsh` 一并运行。宿主 SDK 来自显式指定的 DSH 安装，不新增生产依赖；隔离临时配置/状态。真实 Node 子进程、PTC bridge、Session 原生工具流水线与真实 Reroute 引擎运行，只有 Provider 被注入为 mock，无模型或付费云调用。

两项均通过：

- 仅取消嵌套 `reroute_run`：PTC 程序收到 `ToolCallError`，没有 canonical Job 值/ID；原生嵌套 dispatch 日志保留已分配 Job ID。
- 取消外层 `run_code`：固定宿主返回 `CODE_RUN_FAILED`，诊断为 `abort`，而非外层 `ABORTED`；同样没有成功返回值，嵌套 dispatch 仍记录 `ABORTED` 与 Job ID。

均断言等待 Provider close 才结束、只有一次执行和一次审批、没有本地重试，并从同一 live Session 的下一次真实 PTC 调用 `tools.reroute_status({})` 恢复同一个 Job。状态只发出 mock `status` 请求，确认取消/退出码 130，不开始或恢复任务。这是当前 checkout adapter 的 mock-Provider 端到端桥接证据，不是 installed-tarball Provider 执行、完整 Agent loop 或真实云终止保证。

验证过程保留失败边界：最初误用现有 pnpm `10.34.7`，打包安装/调用后在卸载阶段因不支持 `remove --ignore-scripts` 失败；改用此前要求的现有原生 pnpm `12.16.1` 后，完整 `test:dsh` **3/3** 通过，未修改产品或安装测试绕过该错误。Node TypeScript stripping 的 experimental warning 不影响结果。

## 其他未验证项

本地针对性验证阶段**没有运行完整 `npm test` 或完整 clean-consumer 打包检查**。用户现已要求推送并自动触发远端 CI；其结果须另行确认，不能以本地通过项替代。也没有新增真实模型工具选择、付费云、标准 Web/Desktop UI、Windows、冷进程重启及网络故障验收。

上述验证不包含标准 Web/Desktop UI、真实模型或真实云上的 PTC 取消恢复，也不证明插件重载/冷进程重启后的隐式恢复。重载/重启后省略 Job ID 的映射会丢失，需使用持久 receipt 的显式 ID。

下一步：获准后完整回归/完整 clean-consumer 打包门禁 → 再决定真实模型与云端验收及版本发布。

更多设计与使用约束见 [使用说明](DEEPSEEK-HARNESS.md)、[调查记录](DEEPSEEK-HARNESS-FEASIBILITY.md) 和 [工程规格](../specs/engineering/harness-tool-ownership.md)。
