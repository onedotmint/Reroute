# Reroute 0.2 — 本地重构交付

## 范围与结论

在原有实现上完成四轮工作流／核心重构，未推倒重写。源码、Git、编辑器与
Agent 保留本地；构建／测试可以明确卸载，默认透明策略更保守。保留五个
Provider、原运行时恢复、三方同步和并发协调，没有引入新框架、Provider、
运行时 npm 依赖或常驻服务。包版本仍是 `0.1.0-preview.1`，本次不发布。

交付是 **本地验证完成、可准备受控远端验收**，不是生产就绪或真实云端认证。
实际 SSH、Daytona + 原生 Pi、云端磁盘保留与计费均为 **UNVERIFIED**。

完整操作指南：[WORKFLOW-0.2](WORKFLOW-0.2.md)。配置／迁移权威说明：
[CONFIGURATION](CONFIGURATION.md)。

## 各 Round 实际改动

### Round 1 — 完整使用流程

- `setup --provider … --host …` 可在同一入口配置项目；TTY 简洁引导，非交互
  没有显式项目参数时只设置自身并给出下一步，不阻塞、不默认启用云端。
- setup 检查本地运行环境和凭据 presence；不把它称为认证成功，也不默认
  安装检测出的 Agent。SDK／扩展安装分别需要 `--install-sdk`／`--harness`。
- bare `reroute`／`status` 是可读状态，`status --json` 保留机器接口。状态不
  自启 daemon／调用 Provider；runtime remote state 是 unknown、readiness
  UNVERIFIED、billing UNKNOWN。daemon 不可用时任务数未知，不伪造 0。
- `reroute cargo test` 是显式 argv 远端执行，复用 exec／Coordinator 通道，
  不解释任意 Shell 文本；内部命令优先，歧义与危险位置参数会拒绝。
- `enable`、`exec --`、`local --`、既有 shell bridge 保留。Pi 仍使用原生
  Bash schema／streaming／cancel，不新增模型工具、MCP 或 Agent 框架。

### Round 2 — 保守任务分流

- 一个共享 argv classifier：轻探针、未知解释器脚本、安装、包装器、控制、
  认证、发布／部署默认本地；常见构建／测试／检查是远端候选。
- 精确 `routing.local`／`remote` argv-prefix 项目规则；local 优先，安全排除
  不可被规则或显式 exec 覆盖。未知 make target、clean/install/deploy 保守。
- explain 与实际透明路由共用策略；保持只读、不启动模型／网络／扫描仓库。
- 旧显式 `routing.commands` 无 mode 保留 `legacy`，setup／enable／explain
  给出兼容提示。内置默认变成 tasks；显式 `mode = "tasks"` 才迁移旧规则。
- 多层脚本隐藏的部署无法静态保证；包装器保守本地，不做复杂 Shell 解析。

### Round 3 — 同步与产物

- 实测后复用 **已有 Python guarded apply 数组协议**：推送按 128 个文件／
  约 4 MiB JSON 分批，已有支持的大文件单独发送。保留逐路径 expected hash、
  删除先行、并发保护、备份、冲突证据和全部成功才推进 baseline。
- 去掉每插入一个文件就 `Object.keys(manifest).length` 的扫描计数开销。
- 新增显式 `artifacts`：仅配置的精确构建文件，最多 100 路径／32 MiB 每文件；
  同一项目 lane／Provider transport，输出到全新 `.reroute/artifacts/UUID/`。
  不覆盖源码、缓存、既有下载，不修改源码 baseline，不自动下载整个目录。
- 没有 mtime hash cache、文件索引／数据库／watcher，也没有替换三方同步器。
  未修改执行仍扫描／哈希整个源码树；回传仍逐文件 RPC，大文件完整传输。

### Round 4 — Provider／生命周期

- 有效配置须显式授权所选付费 Provider，默认无授权，包括旧 enabled 项目。
  `setup/enable --allow-paid` 与凭据检测分离；拒绝发生在准备资源之前。
  撤销不是 stop；已运行原资源仍能安全回传并停止，不借此恢复停止的计算。
- SSH 已记录 runtime 只验证，不能 initialize 修复失去的 owner/generation；
  执行／文件操作校验原配置路径与身份。destroy 在同一原生 Python 调用中
  验证再删除；不存在需安全路径证据，symlink／ENOTDIR／连接故障不算 missing。
- 共享 transport 收敛 workspace generation 校验，五个 Provider 的损坏 marker
  均有拒绝测试；删除已废弃的较弱 `DESTROY_DIRECTORY` 实现。
- Daytona 自定义 endpoint／SSH host／port 在 SDK／创建前校验；无效本地
  generation 在恢复 compute 前拒绝；短期 SSH access 尊重 native expiry。
- 控制调用默认 60 秒 deadline、失败 kill transport；显式 SSH bootstrap
  十分钟。作业超时不冒充总 provisioning／sync deadline。
- 普通 stop 不为 clean stopped runtime 恢复计算；stop／destroy 输出区分
  无记录资源、原生停止／删除完成和费用未知。保留 pending、原 ID、root、
  generation、基线；失败不偷偷改为本地执行或创建替代工作区。
- SSH preview 换端口会替换旧 tunnel，旧异步清理不能抹掉新的缓存。

## 关键文件

| 类别 | 文件与作用 |
| --- | --- |
| CLI | `src/cli/main.ts`、`setup.ts`：流程／状态／共享 enable 配置／明确授权 |
| 核心 | `src/core/routing.ts`、`coordinator.ts`、`contracts.ts`：任务分类、授权、lane、恢复 |
| 配置 | `src/config/config.ts`：旧策略兼容、新规则／产物／授权校验 |
| IPC | `src/daemon/server.ts`：同一 core 配置校验与显式／透明请求边界 |
| 同步 | `src/sync/sync.ts`：有界批处理／计数；新 `artifacts.ts`：隔离下载 |
| 通道 | `assets/worker.py`、`src/providers/channel.ts`：受限 artifact RPC，沿用 guarded apply |
| Provider | `common.ts`、`ssh.ts`、`daytona.ts`：超时、原工作区校验、preflight |
| 验证 | 新 task-routing／control-capture／paid-consent／artifacts／sync-batches／ssh-workspace tests；扩展现有五 Provider、CLI、只读 tests |
| 数据 | 新 `scripts/benchmark.mjs` 和 `docs/verification/ROUND3-FINAL-BENCHMARK.json` |
| 文档 | WORKFLOW-0.2、BENCHMARK、本文；更新 README／CONFIGURATION／ARCHITECTURE／PROVIDERS／SECURITY／LIVE-ACCEPTANCE／LIMITATIONS／HARNESSES／TESTING |

`dist/` 随源码重新生成且经过 parity gate，未手改。无需修改 Pi adapter：既有
原生桥接及 ownership uninstall 保护可复用。不删除用户兼容入口、不改变
Provider 数量；唯一删除的执行实现是已无调用的较弱目录删除 helper。

## 成熟技术复用与复杂度

继续使用 Node 标准库、OpenSSH/native Provider SDK、Python 标准库监督通道、
现有任务 lane 和 guarded batch 协议。编译缓存继续交给 sccache／Bazel／Nx／
Turborepo 等现成工具；本轮没有自行实现缓存系统。

rsync 有 delta／批量传输价值，但不能直接替代现有三方 baseline、expected
hash、冲突、排除、pending 和失败恢复。Mutagen 增加远端 agent/session 与
第二套同步生命周期；没有当前证据证明总复杂度和安全收益更优。均未安装／
接入，也没有宣称完成它们的性能或正确性验收；见 [BENCHMARK](BENCHMARK.md)。

新增／移除 npm 依赖 **0／0**，package.json 和两份 lockfile 未变；新增常驻
进程 **0**。默认 setup 不再启动 daemon，状态查询不再产生 cloud API 工作。
现有按需协调器、显式 dev 同步定时器继续存在。冷／warm 配置校验收敛到 core，
Daytona／其他 Provider 共用传输验证，不再维护重复桥接实现。

**不能声称代码总量或整体维护复杂度下降。** 新安全／产物能力、tests、证据与
说明增加了代码；CLI dispatch 仍是大函数，AFT 曾报告 complexity 从基线 65
增至 89。本次减少的是重复路径、无必要激活和 worker 启动，不是人为删行。
以后拆分 CLI 应围绕真实维护问题，不为架构美观再建框架。

## 实测性能

Linux/WSL2、Node 24.21.0、Python 3.14.4，ext4 暖缓存，真实本地 Node + Python
worker，三轮独立树，120 同步阶段 + 120 本地命令样本。部分测试并行运行，
没有统计显著性或云端外推。下面是典型阶段中位数：

| 数据集／阶段 | 基线耗时 → 批处理耗时 | CPU 时间 → | 最大进程 RSS → |
| --- | ---: | ---: | ---: |
| 32 × 4 KiB，首次 | 1.63 s → 0.287 s | 1.68 s → 0.290 s | 64.1 → 63.4 MiB |
| 256 × 32 KiB，首次 | 12.21 s → 1.30 s | 12.57 s → 1.37 s | 73.0 → 101.2 MiB |
| 2,048 × 1 KiB，首次 | 96.76 s → 7.92 s | 98.07 s → 7.76 s | 95.7 → 77.9 MiB |
| 2,048 小文件，不变 | 约 2.8 s → 约 2.6 s | 仍完整扫描／哈希 | 约 75 MiB |
| 20 小文件增量推送 | 3.69 s → 2.47 s | 3.72 s → 2.33 s | 74.6 → 74.2 MiB |
| 4 × 16 MiB，首次 | 1.48 s → 1.85 s | 1.79 s → 2.01 s | 约 279 MiB |
| 16 MiB 一字节变化回传 | 4.14 s → 3.94 s | 4.27 s → 4.06 s | 417.6 → 422.7 MiB |

2,048 文件首次 apply RPC 从 2,048 降至 16。内容读取量**没有减少**；不变
64 MiB 数据集仍读 64 MiB 本地源码。所有 block-read 计数 0 是暖 page cache，
绝非“无磁盘／文件读取”。RSS 是最大单进程高水位，不是进程家族并发总和。

本地包装 p50：`local -- node` 101.4 → 106.5 ms；disabled Git shim 74.1 →
76.5 ms。相对 bare 同程序，当前额外约 **68.0／68.7 ms**，没有本地包装加速。
当前最大进程 RSS 约 61 MiB；完整 daemon／native Pi／enabled-project 成本和
真实网络额外身份校验成本未测。普通不经 shim 的 Git 不支付该 executable
包装成本，Agent shell 激活成本仍未测。

详细方法、全部阶段、p95、CPU、logical read、block I/O 与指纹见
[BENCHMARK 最终章节](BENCHMARK.md#bounded-batch-implementation-archived-final-synchronization-comparison)。
归档原始 JSON SHA-256：
`54353380c89eb9d88ef17a68316ae4a73de25ec5803dfbfa3e42a2aae561666c`。
测量快照晚于 batch 改动、早于最后 CLI guard／provider 校验收敛／cold config
校验；工具明确冻结 dist，不冒充整个最终工作树／真实云端性能认证。

## 测试报告

| 门禁 | 最终结果 |
| --- | --- |
| 基线 Node 24 `verify:release` | 289/289；通过 |
| 重构 Node 24.21.0 `verify:release` | 408/408，失败 0、取消 0、跳过 0 |
| 重构 Node 22.23.2 `verify:release` | 408/408，失败 0、取消 0、跳过 0 |
| dist freshness／TS typecheck／pinned Daytona SDK declarations | 两个 Node 门禁均通过 |
| smoke／tarball／隔离 offline prefix install／installed CLI/export | 两个 Node 门禁均通过 |
| forced-off `test:live` | 0 通过、0 失败、5 跳过；UNVERIFIED |
| 最后三轮 benchmark | 120 sync + 120 command assertions 通过 |
| benchmark self-check（独立任务） | 最终小样本 40 sync + 16 command assertions 通过 |
| Charterleaf lint／git diff --check | 0 structural errors／无 whitespace errors |

覆盖首次／迁移、实际 PTY 与非交互初始化、explicit／transparent 路由、未知／
控制／多层脚本歧义、源同步／删除／并发修改／冲突、批次中断／retry、产物
隔离、remote failure／timeout／cancel／original recovery、资源停止与
adapter install/uninstall 后保留无关配置。native SDK fixtures 和真实本地
Python 子进程仍不是云端／原生 Pi 成功。

过程中 auth reload 输出回归、legacy 无参数命令和 PTY exit 观察竞态先失败，
随后修正并复跑；一次与尚在编辑的 SSH 测试重叠的运行取消，最终没有取消。
无遗留本地测试失败。AFT 某些全量 diagnostics 为 PARTIAL；最终 scoped
核心检查为 FRESH 0 errors/warnings。authoritative 门禁是 pinned typecheck
及上述实际执行，不把 AFT 空结果当成全项目编译证明。

## 安全、兼容与剩余问题

保持本地权威、三方 source／hash／冲突副本、强制 credential/build/state
排除、同项目串行 lane、syncPending 与原 runtime/generation、stdin byte流、
stdout/stderr／exit、timeout／cancel 和绝不偷偷本地 fallback。

迁移注意：status 默认变为人类可读，机器调用需 `--json`；旧显式 commands
保留 legacy 提示；旧托管项目需要明确费用授权。SSH 缺失 recorded generation
必须恢复原元数据／disk，不能自动修复 owner 掩盖丢失。重配 config 需 enable
刷新 warm coordinator；有 pending 不会在 setup 中自动恢复 compute。

### 使用真实云端之前必须完成

- 明确账户 owner 授权、预算上限、既有远端环境／工具链与清理责任人。
- [LIVE-ACCEPTANCE](LIVE-ACCEPTANCE.md) 的 Daytona + native Pi、SSH + native Pi
  联合流程；包含原工作区 disk persistence、crash-stop、恢复和原生费用证据。
- 严格区分本地/mock 成功和上述实际验收。没有证据的项目仍 UNVERIFIED。

### 以后再做，不阻塞本地交付

- 降低大文件 base64/JSON/backup 回传内存，或在有证据和兼容测试后做 streaming。
- 优化 unchanged 哈希与 glob 重复编译，不拿 mtime 替代当前内容保护。
- 单独测 enabled-project／daemon／native agent 延迟与 RSS、冷缓存和真实网络。
- 跨 Provider 全准备阶段的即时 abort／总 deadline 仍有限；当前受原生与控制
  deadline 约束，不宣称所有 provisioning/sync 均能立刻取消。
- CLI 大函数的维护性、平台／原生 Windows/macOS、其他云 SDK live 认证。
- 费用 watchdog、通用调度／AI 服务／新 Provider 都不在本轮范围。

## Git 与操作边界

- 开始时工作树干净：`hardening/pre-test`，基线完整 SHA
  `e2c77e2248315cbcdf4075d17d7952c6becc0435`。
- 独立工作分支：`refactor/workflow-0.2`。原分支／提交保留，可直接比较。
- HEAD 未变，**没有创建自动提交**；所有本轮改动保留在工作树，包括源码、
  生成 dist、测试、文档、规格和 raw benchmark。当前 Charterleaf 指令禁止
  自动 commit，故没有为了 Round 切片重写历史或假造中间提交。
- 没有 stage、push、发布、部署、真实云账户任务、资源创建或破坏性云清理。
- 安装／adapter 测试使用隔离配置；早期一个新 fixture 未隔离 REROUTE_HOME
  的测试产生了四个 synthetic index，已检查为本次创建的临时项目并精确清理，
  fixture 随后改为隔离 HOME；未改用户凭据或既有 Agent 配置。
- 本地受控验收前提已具备；云费用授权／真实账户与环境未验证，所以**不具备
  自动开始付费验收的许可**。本交付文档与凭据 presence 均不是该许可。
