# DeepSeek Harness 接入可行性调查

历史记录：本文保留实现前的调查及隔离 fixture 探针，不代表当前代码状态。后续已实现双宿主接入，但仍有两项审批竞态待修、未完成全套验收；当前进度以 [WIP 状态检查点](DEEPSEEK-HARNESS-STATUS.md) 为准。

## 结论

可以做，不需要重写 Reroute 的远程执行、Provider、快照、缓存或预算系统。可靠首版是**中等难度的宿主适配**，不能仅把 `runRemote()` 注册成工具。

建议首版：一个原生 Host 插件，提供前台 `reroute_run` 和 `reroute_status`，复用现有 CLI 配置与私有项目授权；保留 Pi。先不做后台任务、专用 Web 卡片、设置面板、SSH execution-world 文件读取或多用户服务。

调查基线：

- 本地 Reroute：`0.4.1`，Git `d24081d`，调查开始时工作区干净。
- npm 查询的 `@deepseek-ai/dsh` latest/next：`0.2.1-rc.5`；alpha：`0.2.2-alpha.2`。
- 上游 master 的 package.json：`0.2.2-alpha.2`。官网与 master 不是已发布 latest 的固定 API 合约。
- 首个候选兼容目标建议固定为 `0.2.1-rc.5`，以该版本实际安装/加载测试结果为准，不宣称支持全部 0.2.x。
- 本地 Node：`v24.22.1`。后续实测找到 Linux npm 缓存中的 `0.2.1-rc.5`（虽然 `dsh` 不在 PATH）；Windows 另有 `0.1.0-rc.6`，本次没有运行 Windows 版本。上游 master 声明 Node `>=24.9.0`；这不证明所有已发布包及 Desktop 的运行要求。

## 已核实的 Harness 接口

| 能力 | 查证结果 | 对 Reroute 的影响 |
| --- | --- | --- |
| 插件加载 | 模块导出 `name`、`inject`、`apply(ctx)` | 不需要改 agent loop |
| 工具注册 | `ctx.tools.register(defineTool(...))` | 新增宿主入口，不能复用 Pi 的 defineTool |
| 输入 | `parameters` DSL，属性通过 `required: true` 标记必填 | 正数、非空、跨字段校验仍由插件完成 |
| 输出 | `output.schema` + `execute(args, exec)` 返回 canonical JSON，`output.render` 生成模型文本 | 不能直接返回 Pi 的 content/details/structuredContent/isError envelope |
| 调用身份 | `exec.agent` 可缺省，`exec.signal` 必须传递 | 首版拒绝无 agent 的模型工具调用，禁止退回 process.cwd() |
| 当前目录 | `ctx.workingDirectory.ensure(agent, signal)` | 每次调用读取会话目录，不缓存进程启动目录 |
| 文件坐标 | FS provider 的路径属于 execution world；`processPathFromHostPath` 只在同一文件可映射时返回路径 | SSH 上的同名路径不代表本地同一项目 |
| 宿主审批 | `ctx.approval.request(...)`，仅 `allowed-once` 放行 | 不将一次审批转换成永久项目授权 |
| 审批策略 | `never` 对审批请求返回 rejected；无 answerer 则 unavailable | 不能把 never 理解成自动批准；首版交互策略必须实测 |
| 沙箱 | `sandboxPolicy.resolve({ session })` 提供文件效应 mode 与 workspaceRoot | 不会自动约束插件直接调用的 Node FS 或云 SDK |
| Plan | 是 soft guidance，独立于沙箱与审批；已发布控制器支持 `get(agent)` | 如首版承诺计划模式不执行，应显式检查，不能只依靠提示词 |
| 提示词 | `ctx.systemPrompt.section()`；PTC 调用自动经过正常工具流水线 | 加入工具选择和恢复说明，无需修改整个 prompt assembly |
| 后台 | `ctx.jobs` 有自己的 ID、owner、取消与清理生命周期 | 不能把 Reroute UUID 当 Harness Job ID；首版先不接 |
| 展示 | 无专用展示可使用通用卡片；内置 Web 不消费 Host presentCall/presentResult | 首版不承诺实时阶段展示或定制 Web 卡片 |
| 分发 | npm bundle 声明 `dsh.bundle.patch`，patch 插入插件行；profile 管理安装组合 | 只有 JS 导出不等于可安装插件 |

已额外读取 `0.2.1-rc.5` 发布包的 schema、工作目录、FS、审批、沙箱策略与计划模式类型声明。工具执行参数类型在该版本为 `ToolRunContext`；master 的文件组织和 API 已有变化，因此不要照抄 master 的类型名或内部路径。部分大型声明读取被截断，没有据此推断缺失接口。

## Reroute 的复用与缺口

### 可以复用

- `src/engine.ts:134-162`：远程执行、项目 consent、快照前验证、资源准备入口。
- `src/engine.ts:292-350`：项目 scoped 的任务查询、远程 receipt 校验、查询结果持久化。
- `src/router.ts:44-60`：命令资格与 local/remote 决策。
- `src/config.ts:84-108`：私有、canonical project/account scoped 的授权。
- 现有 Provider、资源预算/所有权、凭据排除、缓存和任务监督逻辑。

`src` 中的 Pi SDK 导入仅出现在 `src/pi.ts`。底层引擎未依赖 Pi SDK，这使双宿主支持可行。

### 不能只包 runRemote

`runRemote` 本身**不调用 ruleRouter**。当前无配置/不合格/local-mode 的拒绝、部分参数校验、有界输出、UTF-8 解码和工具结果语义在 `src/pi.ts:38-197`。新入口直接调用 engine 会丢掉这些工具层行为。

最小调整是把 run/status 的宿主无关执行与结果 DTO 提到一个共享模块，Pi 保留自己的 schema、确认 UI、进度 envelope、命令和面板；Harness 使用自己的 schema、审批与 renderer。不需要建设通用插件框架。

## 最重要的范围边界

Reroute 的 `projectRoot()` 会向上发现 Git root 或祖先 `.reroute.json`；`snapshot(root)` 上传的是整个项目根，不是仅当前 cwd。证据：`src/config.ts:40-73`、`src/engine.ts:139-151`、`src/snapshot.ts:14-49,72-93`。

例如：

```text
Reroute project root R: /work/repo
Harness workspace W:   /work/repo/packages/a
current cwd C:         /work/repo/packages/a/src
```

直接套用当前 engine，可能上传整个 `/work/repo`。这符合现有 Reroute 的整项目 consent 设计，但不能直接推断符合新宿主用户的期望。

**准确区分：Harness 的 W 是 workspace-write 的写入根，不是通用读取根，也不是网络/源码上传授权。** 将 `R` 限定在 `W` 内是建议的首版保守上传策略，不是 Harness 已自动提供的保证。不要将上述情况描述为已经证实的现有 Reroute 漏洞。

建议首版规则：

1. 只支持可证明与 Node Host 同文件映射的本地项目。C、W、R 均须处于可比较的 canonical host 坐标系。
2. 上传范围满足 `C ∈ R`、`C ∈ W`、`R ⊆ W`；R 高于 W 时拒绝，并提示从完整项目根打开会话。
3. 不把 R 静默截断为 C/W：那会改变项目配置、输入集合、授权身份和缓存命名空间。
4. 在读取所选项目配置、准备 snapshot 或联系 Provider 前完成范围核准。建议给项目发现/配置加载增加可选可信搜索上界；不传时保持 Pi/CLI 原行为。
5. 上界不能被模型工具参数覆盖。Git 元数据探测仍是受信宿主逻辑，不能将搜索上界包装成完整 OS 读取沙箱。
6. 用户配置、凭据、Job/授权记录和临时目录是宿主认可的插件私有能力，可能在 W 外；它们不是模型可任意指定的文件路径。workspace-write 本身不自动授权这些能力，也不自动阻止它们。这里的准入是安装信任与调用审批的产品约定，不意味着已找到统一的 SDK 私有路径授权 API；首版不另造通用 ACL 框架。
7. 首版建议在 read-only/有效计划状态下拒绝新 run，且不提供模型可调用的 authorize 工具；这是插件自己的保守行为。

## 授权与调用方案

三种授权不合并：

- Harness 对当前调用和宿主能力的准入。
- Reroute 对 canonical 项目、Provider/account、源码上传和远程脚本执行的持久 consent。
- Managed profile 对可计费资源的显式授权及预算限制。

首版建议通过已有 CLI 由用户预先完成 Reroute setup/authorize；插件不悄悄运行 `authorize --yes`，不自动改配置。Harness 侧保守方案是每次新 run 再使用一次性审批，且只放行 allowed-once；该方案在 approval=never 下会拒绝，必须明示并在 PoC 验证，不能声称无人值守模式已受支持。

### run 调用顺序（拟议，不是现有 API）

```text
参数校验、检查 caller/signal
→ 解析会话 policy 与当前 cwd
→ 验证本地文件世界与项目范围，受限发现 project root
→ 读取核准配置，ruleRouter
→ 无配置/不合格/local-mode：not_started，零执行
→ 检查私有项目 consent、宿主能力/模式与一次性审批
→ 用同一组已核准 root/config/cwd 调用共享执行器 → runRemote
→ 返回有界 JSON；由 Harness renderer 生成可读输出
```

审批等待后应检查取消及相关权限是否仍有效；不得用此前检查的运行状态作为资源启动授权。核心仍保留执行前 consent 和预算校验。

### status 调用顺序

```text
caller/signal/policy/cwd 与文件世界校验
→ 在准入范围内确定当前项目根
→ 读取合法 Job ID 对应的私有记录，核对 ID 与 canonical Job.project
→ 不匹配：不展示外项目记录，不联系 Provider
→ inspectJob(id, 'status', { project, signal, onConfirmed })
→ 返回 recorded 字段、remoteConfirmed、remoteStatus、exitCode 与 error
```

status 不需要重新授予“执行 consent”，撤销新任务授权后仍应能查询获准 scope 内的旧任务。它远程只查询，但 `inspectJob` 会更新**本地** receipt，不能宣传为全流程无写入。没有相应私有状态访问能力就拒绝 live refresh；不要把历史记录伪装成新确认。

沿用现有 E2B scoped 查询的 fail-closed 行为，不借接入顺便修复或扩展 Provider。

## 返回值、取消和长期任务

- 沿用 run 字段：status、exitCode、jobId、reason、stdout、stderr、outputTruncated、metrics。
- 沿用 status 对历史与新确认的区分；有 receipt 但本地保存失败时保留确认事实与保存错误。
- Harness 的工具调用成功不等于远程任务成功。可描述的远程非零退出/failed/unknown 应作为领域报告保留 Job ID；插件自身 schema/运行故障与宿主拒绝才走相应调用错误。不要机械照搬 Pi 的 isError。
- 特别验证 PTC：抛错路径没有成功 canonical value，不能让异常吞掉恢复必需的 Job ID。取消可能被宿主规范化为调用错误，必须实测 Job ID 是否仍可从已持久化记录找回。
- `exec.signal` 传到底层，取消后等待自有清理；失联/unknown 不等于远程已停，绝不自动重试。
- 首版前台等待完成，不实现自动转后台，不虚构进度。不设置短于真实任务生命周期的随意固定工具 deadline。
- 插件卸载时显式取消/等待尚在本插件拥有的操作；仅工具注销不证明网络工作已结束。不能承诺进程硬退出一定停止云端计费。
- 以后接 ctx.jobs 再处理双 ID、owner、任务独立 signal、取消/清理和日志保留，不为首版预建框架。

## 最小文件变更范围

| 文件/区域 | 拟议改动 |
| --- | --- |
| 新 `src/tools.ts`（名称可调整） | 抽出共享 run/status 执行、DTO 和必要的有界输出逻辑 |
| `src/pi.ts` | 调用共享模块，保留 Pi UI/命令/加载行为 |
| 新 `src/dsh.ts` | Cordis apply、两个工具 schema、caller/scope/审批与 renderer |
| `src/config.ts` | 项目根/配置发现的可选可信上界，保持旧调用默认行为 |
| 新 `cordis.patch.yml` | 插入 `@onedotmint/reroute/dsh` |
| `package.json` / lock | `./dsh` 指向编译入口、dsh.bundle、固定兼容范围、SDK 开发依赖/合适的 optional peers、打包文件列表 |
| `scripts/check-package.mjs` | 允许并检查新 patch/编译入口；不破坏无 SDK 生产安装约束 |
| 测试 | 共享行为、Harness native/PTC、权限范围、安装/卸载与 Pi 回归 |
| 文档/工程规格 | 两个宿主的边界、配置授权、支持环境与明确不支持项 |

大致十来个文件/区域；其中大部分是入口、测试与包装，不是远程业务重写。SDK 作为宿主提供的能力，避免 Pi 普通安装顺带装完整 DSH。具体 peer 组合以隔离安装验证为准。

优先在同一个 npm 包增加子路径与 bundle 元数据，不先拆多仓库/多包。现有 `.` 引擎导出与 `./pi` 保持不变。使用 npm/tgz 预构建分发，不为了 DSH 改坏 Pi 已支持的源码 Git 加载，也不新增安装时自动构建权限。

## 分阶段实施与验收

### A. 无计费兼容性探针：先决定是否正式实施

在仓库外的临时环境固定安装目标版本，用独立 DSH_HOME/配置/状态目录：

1. 加载一个最小 Host 插件，注册两个工具，以 fixture executor 返回 JSON。
2. 验证 native 和 PTC 都拿到字段，不要求模型解析文本。
3. 在真实会话读取 cwd，核实本地 FS mapping、policy 和 approval 的拒绝/取消路径。
4. 人工取消长 Promise，验证 signal 与卸载清理；检查 Job ID/恢复记录是否能保留。
5. 用 tgz/profile 验证安装、加载、卸载；不改用户现有 profile，不上传源码、不调用云厂商或真实模型。

A 未通过，不先做核心共享逻辑重构或许诺发布兼容。

### B. 实现共享边界与适配

- 先提取共享工具逻辑，跑原有 Pi 测试，确认行为不变。
- 加可信搜索上界和 Harness 范围/审批检查。
- 接入真实引擎，使用隔离本地 Provider fixture 走实际引擎/receipt 链路。
- 包装与文档完成后，再进入实际模型/云端验收。

### C. 必测回归

现有基础：`tests/pi.test.mjs`、`pi-authorization.test.mjs`、`pi-status.test.mjs`、`inspection.test.mjs`、`global-config.test.mjs`、`router.test.mjs`、`native-package.test.mjs` 和打包检查。

新增/复用测试至少覆盖：

- 无配置、local-mode、非法/复杂命令与无 consent：零 snapshot/上传/provisioning。
- 一次性审批拒绝、缺失、never、等待时取消：零执行且不持久授予 consent。
- monorepo 子包 W 小于 R：拒绝；W=R、C 为子目录：允许。
- W 外祖先配置不被继承；canonical alias、嵌套项目与根发现上界。
- SSH execution-world 与本地同名目录不可混淆；没有 mapping 时无 fallback。
- 有持久 consent、变更 cwd、用户同意一次请求均不能突破首版上传范围策略。
- 非零退出、timeout、cancel、unknown、上传错误、结果过长、UTF-8 分片、保存失败。
- status 跨项目不泄漏；撤销执行 consent 不妨碍获准查询；历史成功不等于 remoteConfirmed。
- native 与 PTC 返回值一致；工具错误/取消路径仍能恢复 Job ID。
- 插件卸载不会静默遗留自有前台工作；断连不虚构终止或自动重跑。
- 新 bundle 独立安装/加载/移除，不重复注册；Pi 源码 Git 加载、普通生产依赖与既有导出不退化。
- 用户另行授权后再做真实模型选择测试：轻工作留本地、重工作选 Reroute、失败先查状态且不本地重跑。

真实云测试还需要单独授权和费用上限；沿用 Provider 已知限制，不因适配通过就宣称所有云端已验证。

## 难度与工作量判断

| 项目 | 判断 |
| --- | --- |
| 插件注册、schema、基础包装 | 低 |
| 共享逻辑提取且 Pi 不退化 | 中 |
| 文件世界、项目范围、授权与失败语义 | 中，是主要工作 |
| 使用既有 Provider 的完整执行链 | 可复用，但新宿主仍需验收 |
| 原生后台、实时 Web 卡片、配置面板 | 额外中到高，不在首版 |

结论是“范围可控、值得做”，不是“几行代码即可发布”。A 通过后才给实现排期；在此之前，无依据的精确工期或复用百分比没有意义。

## 调查范围与未验证项

已做：只读代码/规格/测试结构调查、官方文档和发布声明核对、npm 元数据查询、本地 runtime/Git 状态检查。AFT 对 `src/pi.ts`、`src/engine.ts`、`src/auth.ts` 三个文件返回完整诊断覆盖且无诊断；整体报告的 dead-code Python 支持缺口与本调查无关，不能据此声称全仓库健康。

未做：没有实现或接通 Reroute 引擎，没有运行其产品测试或构建，没有真实模型调用、源码上传或云端资源操作。已使用现有 Harness 完成下述隔离 fixture 实测；不能将它等同于完整 Reroute 适配验收。

## 查证来源

官方文档（当前站点，可能随版本变化）：

- [工具编写参考](https://deepseek-harness.github.io/deepseek-harness/en/reference/cookbook/adding-a-tool)
- [首个插件](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic)
- [插件打包与安装](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/publish)
- [宿主审批](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/approval)
- [进程沙箱](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/sandbox)
- [计划模式](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/plan)
- [后台任务](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/jobs)
- [提示词服务](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/system-prompt)

固定版本发布包声明（UNPKG 镜像读取，不代表已实际运行）：

- [0.2.1-rc.5 工具 schema](https://unpkg.com/@deepseek-ai/dsh-tools@0.2.1-rc.5/lib/types/schema.d.ts)
- [工具结果与执行类型，读取有截断](https://unpkg.com/@deepseek-ai/dsh-tools@0.2.1-rc.5/lib/types/index.d.ts)
- [工作目录](https://unpkg.com/@deepseek-ai/dsh-working-directory@0.2.1-rc.5/lib/types/index.d.ts)
- [文件系统](https://unpkg.com/@deepseek-ai/dsh-fs@0.2.1-rc.5/lib/types/index.d.ts)
- [沙箱 mode 与 workspaceRoot 的精确定义](https://unpkg.com/@deepseek-ai/dsh-sandbox@0.2.1-rc.5/lib/types/index.d.ts)
- [沙箱策略](https://unpkg.com/@deepseek-ai/dsh-sandbox-policy@0.2.1-rc.5/lib/types/index.d.ts)
- [审批](https://unpkg.com/@deepseek-ai/dsh-user-approval@0.2.1-rc.5/lib/types/index.d.ts)
- [计划模式](https://unpkg.com/@deepseek-ai/dsh-plan-mode@0.2.1-rc.5/lib/types/index.d.ts)

另读取上游 master 的 [工具示例](https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/shell/tool-bash/src/index.ts)（有截断）、[工作目录实现](https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/session/working-directory/src/index.ts) 与 [根 manifest](https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/package.json)，仅用于理解架构和版本差异，不当作固定发布合约。

## 现有安装的隔离实测结果

使用已有 Linux 安装：`/home/dotmint/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh`，CLI 实测版本为 `0.2.1-rc.5`，没有下载或升级 Harness。

执行方式：真实 `dsh --profile probe` 启动自建最小 profile；真实 Cordis Loader、工具 registry、Session、working-directory、sandbox-policy、approval 和 Node PTC runtime。fixture caller 不是模型驱动的 Agent loop，审批 answerer 是测试 listener，不是人工 UI。所有工具只返回固定数据或等待取消，**不导入 Reroute 引擎，不执行用户命令，不扫描/上传项目，不调用模型或 Provider**。

隔离路径：`/tmp/reroute-dsh-probe-tZjFpW`。启动使用清空后的环境，仅传 PATH 与临时 HOME/DSH_HOME/DSH_AGENTS_HOME/XDG 路径，`DSH_TELEMETRY_DISABLED=1`；没有读取真实凭据配置或修改用户 profile。

结果：

| 实测 | 结果 |
| --- | --- |
| 真实 CLI 加载插件、注册两个工具 | 通过 |
| native 调用、canonical JSON、schema 拒绝错误参数 | 通过 |
| 模拟拒绝执行、非零退出、unknown 保留 Job ID | 通过 |
| 抛错变为 Harness error 且没有 canonical value | 已确认 |
| policy deny 与 agentless ask 不进入执行体 | 通过 |
| 真实 Session 切换 cwd，原 policy root 不变；本地 FS path mapping | 通过 |
| approval unavailable/rejected/allowed-once/never/cancelled | 通过，未验证图形审批 UX |
| 开始前取消不执行，开始后取消先等待 fixture 清理 | 通过 |
| 显式插件 disposer 取消并等待自有工作，注销工具 | 通过；此能力是 fixture 主动实现，不是免费获得 |
| PTC 通过真实受文件沙箱约束的 Node 子进程调用两个工具 | 通过；返回 mode=workspace-write、enforcement=full、denied=false，仅代表该探针 |
| PTC 子工具调用仍经过正常 policy，直接调用 native 名称被拒绝 | 通过 |
| 本地 tgz 经 dsh plugin add 安装，bundle 自动激活、PTC 调用、remove | 通过，移除后清单已断言为空 |

native 12 项、PTC 4 项检查通过；安装后的 bundle 又重复通过 PTC 4 项检查。结构化结果与探针源码保留在忽略目录 `.artifacts/dsh-probe/`：`native-result.json`、`ptc-result.json`、`packed-result.json`、`packaging-result.json`、`fixture-plugin.mjs`、`runner-plugin.mjs`。

### 实测发现：取消会丢失返回值中的 Job ID

fixture 在取消后先完成自有清理，再返回 `{ status: 'cancelled', exitCode: 130, jobId: ... }`，但 Harness 将成功领域结果替换为 `isError=true` 的 `AbortError/ABORTED`，`value` 不存在。因此确认了前文的取消风险；单靠返回 DTO 无法保证取消后的 Job ID 可见。

正式适配应在任务分配时保留调用与 Job ID 的关联及现有私有 receipt，并选择一个经过测试的失败内容投影/恢复入口。不能为了保住结果而忽略 exec.signal，也不能将返回通用 AbortError 解读为远程任务已确认终止。此次只确认现象，尚未实现恢复方案。

### 两个已经解决的探针问题

- 初次 native 探针漏声明 `fs` 注入，宿主明确拒绝访问；补上后全部通过。这说明要完整声明依赖，不能靠 ctx 上有属性就读取。
- 初次隔离安装使用 Corepack shim，因 HOME 隔离触发 pnpm 重新下载并超时。后改用本机已缓存 `pnpm-native`，禁用 Corepack 联网，使用 `--offline --ignore-scripts` 安装本地 tgz 后成功。不需要更改用户全局安装。

结论更新：**基础插件加载、两种调用方式和本地分发路径已有真实运行证据，没有发现阻止接入的障碍。** 下一步可以实施共享工具逻辑与 Harness 适配；仍需独立验收源码范围、Reroute 项目 consent、预算/真实引擎链路、取消 Job ID 恢复、真实 Agent/模型选择、用户标准 Web/Desktop profile 与 Windows，不能以本探针代替这些验收。
