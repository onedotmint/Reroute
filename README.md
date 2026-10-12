# Reroute

**Keep your workspace. Offload the workload.**

源码、Git、编辑器和编码代理留在本地，按需卸载重型构建和测试。

仓库：[onedotmint/Reroute](https://github.com/onedotmint/Reroute) · 版本：`0.1.0-preview.1` · 许可证：Apache-2.0

Reroute 是一个 TypeScript / Node.js 命令执行路由工具。它通过本地 CLI、用户级协调进程和 PATH 命令垫片（shims），让编码代理继续使用原有的 shell 工具，不必为每种远程环境学习新的模型工具。

> 当前是预览版，不是生产就绪或云端兼容性认证。已有本地测试与真实 Python 子进程测试，但云 SDK 契约、真实远程主机和原生代理运行仍需实测。使用敏感或付费环境前，请阅读[安全说明](docs/SECURITY.md)与[已知限制](docs/LIMITATIONS.md)。

**开发中的 0.2 工作流重构：** 一次项目 setup → 简洁状态 → 显式任务卸载 → 安全停止。保守任务分类、独立产物取回和付费授权门禁已加入；安装包仍保留原预览版版本号，未发布。使用方式见 [0.2 工作流](docs/WORKFLOW-0.2.md)，性能证据见[基准报告](docs/BENCHMARK.md)。真实 SSH、Daytona + 原生 Pi、持久化与计费仍为 **UNVERIFIED**；[原硬化记录](docs/HARDENING.md)保留为基线历史，不是本次云端验收结果。

## 项目已有的能力

| 模块 | 当前实现 |
| --- | --- |
| 命令路由 | argv 任务分类：构建/测试是远端候选，版本/轻量/未知脚本/控制任务默认本地；明确规则与显式覆盖 |
| 远程后端 | SSH、Daytona（默认）、SkyPilot、Modal、E2B；统一资源、生命周期和字节流接口 |
| 源码同步 | 前后同步、增量传输、三方哈希比较、删除传播、冲突留存；凭据和构建缓存强制排除 |
| 进程控制 | stdin/stdout/stderr、退出码、超时、取消、进程组清理；不支持 PTY |
| 项目协调 | 用户级认证 IPC、项目身份、串行修改、运行时复用与空闲策略 |
| 开发服务 | 后台 dev 进程、日志尾部、每两秒同步、显式端口预览；需要远程服务和后端支持 |
| 代理桥接 | Pi、Claude Code、Codex、Cursor、OpenCode v2、DeepSeek；支持程度不同，见[代理指南](docs/HARNESSES.md) |
| 验证 | Node 内置测试运行器；单元、后端契约、同步/进程集成、CLI/IPC、代理协议夹具和可选 live 测试 |

**远程执行失败会报错，绝不偷偷改成本地执行。** 需要本地执行时，显式使用 `reroute local -- COMMAND`。

## 安装

本地需要 **Node.js 22+**。SSH、Daytona 和 SkyPilot 的执行通道还需要本地 OpenSSH；远程环境需要 **Python 3** 以及项目自己的语言工具链。推荐 Linux 或 WSL；原生 Windows 路径仍属实验性，需 Git Bash（`REROUTE_SHELL`）。

从源码安装：

```sh
git clone https://github.com/onedotmint/Reroute.git
cd Reroute
npm ci --ignore-scripts
npm run tools:install
npm run verify:release
npm install -g .
reroute --version
```

`dist/` 包含已编译 JavaScript。独立终端向导使用小型 MIT 依赖 `@clack/prompts`（随 npm tarball 打包，支持离线安装）；核心和 Daemon 不加载它，Pi 使用宿主原生组件。源码 checkout 先 `npm ci --ignore-scripts`，改过 `src/` 后重新构建。

也可以 `npm pack --ignore-scripts`，再安装生成的 `reroute-0.1.0-preview.1.tgz`。**目前不声称已经发布到 npm**，不要把 `npm install -g reroute` 当作本项目的安装方式。

## 用现有 SSH 服务器开始

先配置 OpenSSH 登录，亲自确认服务器 host key。Reroute 不生成 SSH 密钥，也不会关闭主机密钥检查。

```sh
ssh my-build-host 'python3 --version'
cd /path/to/my-project
reroute setup --provider ssh --host my-build-host --harness pi
reroute doctor --probe
```

安装扩展后重启 Pi，输入 **`/reroute`** 打开原生管理面板；继续使用 `pnpm test`、`cargo test`、`pytest` 等常规 Bash 命令。↑/↓ 导航，Enter 确认，Space 切换路由类别，Esc 返回/取消。无需模型请求，也不会因为打开面板而创建资源。

直接运行 **`reroute setup`**：选择 Provider → 必需参数（SSH host）→ 本地认证/依赖提示 → Space 多选自动卸载类别 → 摘要 → 确认保存。已有配置自动预填，Esc/Ctrl+C 取消不写配置。非 TTY 保留显式参数；TTY 脚本可加 `--non-interactive`。`status --json` 保持机器可读；`status --live` 或面板的 Manage runtime → Query 才做只读远端查询。详见 [交互指南](docs/INTERACTIVE.md)。

不使用代理也能测试透明路由：

```sh
reroute                       # 当前项目、任务、pending 与下一步
reroute cargo test            # 明确的远端 argv 执行
reroute shell -- 'cargo test && git status'
reroute status --json
```

`cargo test` 是远端候选，Git 保持本地；`python3 -c …` 等未知轻任务默认也留在本地。`reroute exec -- COMMAND` 是显式远程执行入口，不是代理日常使用的必需步骤。未启用项目中的 shims 正常本地透传。

## 托管远程环境

先通过后端自己的方式配置认证，再启动协调进程。例如 Daytona：

```sh
# DAYTONA_API_KEY 由你自己的本地环境提供，不写进项目配置
reroute setup --install-sdk daytona --harness pi
cd /path/to/my-project
reroute setup --provider daytona --allow-paid
reroute cargo test
```

Modal / E2B 使用 `reroute setup --install-sdk modal` / `e2b`，再选择对应 provider。SkyPilot 使用现有 `sky` CLI、云认证和生成的 SSH 配置。

SDK 按需安装在 `~/.reroute/sdk/`；认证不由 Reroute 托管。远程镜像、模板或服务器必须包含实际构建需要的工具链，基础 Python 镜像不是通用开发环境。详见[后端指南](docs/PROVIDERS.md)和 `examples/`。

更改协调进程的认证环境后执行 `reroute auth reload`。它在启动锁内等待旧进程退出，再用当前终端环境启动新进程；超过期限会报错，不会把仍在关闭的旧进程当作重载成功。

## 常用命令

```sh
reroute setup                  # TTY 简洁引导；非交互只安装自身，不擅自启用/授权
reroute setup --provider ssh --host build-host  # 配置项目，不创建运行时
reroute setup --harness pi      # 显式选择；安装后重启 Pi
reroute uninstall --harness pi  # 只卸载未被用户改动的自有扩展/精确 hook
reroute sync --dry-run          # 本地只读：上传范围、排除原因、大小及风险
reroute sync --dry-run --json
reroute explain -- pnpm test    # 不执行、不连接 daemon/云端
reroute explain --json -- pnpm test
reroute                       # 可读状态；不会启动 daemon/调用 Provider
reroute status --json
reroute doctor
reroute doctor --fix            # 只修复 Reroute 自己拥有的文件
reroute local -- cargo test     # 明确的本地覆盖
reroute artifacts              # 取回配置的精确构建文件到隔离目录
reroute enable --allow-paid     # 显式授权当前项目/Provider 的付费资源
reroute enable --revoke-paid    # 仅撤销授权，不代替 stop/清理
reroute stop                   # 按后端语义停止；不会关闭 SSH 服务器
reroute stop --destroy          # 删除运行时，先确认后端语义及需保留的文件
reroute disable                # 停止工作并关闭当前项目拦截

reroute dev --port 3000 -- pnpm dev
reroute dev logs --follow
reroute dev open
reroute dev stop
```

开发服务器需要监听适合远程预览的地址（如 `0.0.0.0`），Modal 端口需在创建前声明。dev 进程会持有租约，避免普通空闲停机；用完后显式停止。

## 配置、同步与安全边界

配置优先级：内置默认值 → `~/.reroute/config.toml` → 项目 `reroute.toml` → `enable` 保存的本地覆盖 → CLI 参数。详见[配置说明](docs/CONFIGURATION.md)。

- 认证凭据存在不等于认证成功，也不等于费用授权。托管 Provider 在首次创建/恢复前要求明确授权；停止计算不保证存储零费用。
- 构建缓存保留远端；产物只按配置的精确文件显式取回，不覆盖源码或既有下载。
- `.git`、`node_modules`、Rust `target`、虚拟环境、构建输出和已知凭据路径不参与源码同步。
- 符号链接会被拒绝，而不是跟随；凭据排除不能被用户配置撤销。
- 双方冲突时退出码为 **73**，远程副本保存在 `.reroute/conflicts/<id>/remote/<原始路径>`，不覆盖有分歧的本地文件。
- 比较并在本地解决后，使用 `reroute sync --accept-local` 明确确认本地版本。
- 回传失败时 `status` 显示 `syncPending: true`，保留原运行时和基线；成功同步后解除保护。Daytona 即使 pending 也保留有限原生 auto-stop，停止/归档后 `reroute sync` 会校验原 ID/工作区 generation 并恢复同一资源。其他不支持恢复的后端须原生恢复，不能跳过回传直接销毁。
- CLI 超时返回 **124**，取消返回 **130**，即使子程序处理终止信号后自行退出 0，也不会被当成成功。
- 命令拦截依赖 PATH，不是安全沙箱；绝对可执行路径、隐藏在脚本中的部署行为或未接入的代理工具可能绕过路由。
- Daytona 活跃任务保留至少五分钟原生 auto-stop，并每分钟刷新 activity；daemon 崩溃后刷新停止。此行为、磁盘保留及实际计费仍标为 **UNVERIFIED**，须配合预算和原生验收；GPU/Spot/VM、硬 TTL 及 auto-delete 不用于 Daytona 源码工作区。其他后端仍有各自的崩溃/生命周期限制。

## 开发与文档

```sh
npm run typecheck
npm run build
npm test
npm run test:live               # 未显式配置时跳过，不代表云测试通过
npm run smoke
```

项目结构：

```text
src/cli/        安装、诊断和 CLI
src/core/       路由、项目身份、协调、队列与生命周期
src/config/     配置合并与受限 TOML 解析
src/daemon/     认证 IPC 服务与客户端
src/providers/ 五种远程后端和共享执行通道
src/sync/       源码扫描与三方同步
src/platform/   文件与本地进程工具
assets/worker.py 远程 Python 监督与受保护文件传输
adapters/       编码代理桥接
examples/       后端配置示例
tests/          单元、契约、集成、代理协议与 live 测试
dist/           生成的 JS / 类型声明，不手工编辑
```

- [0.2 工作流](docs/WORKFLOW-0.2.md) · [性能基准](docs/BENCHMARK.md)
- [架构](docs/ARCHITECTURE.md) · [开发与打包](docs/DEVELOPMENT.md) · [测试](docs/TESTING.md)
- [配置](docs/CONFIGURATION.md) · [后端](docs/PROVIDERS.md) · [代理](docs/HARNESSES.md)
- [安全](docs/SECURITY.md) · [限制](docs/LIMITATIONS.md) · [项目检查](docs/PROJECT-REVIEW.md)
- [Outboard → Reroute 命名迁移](docs/MIGRATION.md) · [历史交付证据](docs/DELIVERY.md)

原始 Outboard 报告和日志保留在 `docs/verification/`，它们不是 Reroute 改名后的测试结果或当前 Git 提交证明。
