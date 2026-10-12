# Outboard → Reroute

这是预览版的完整命名切换，不提供旧命令别名，也不自动迁移本地状态或云资源。

| 原名 | 新名 |
| --- | --- |
| Outboard / npm 包 `outboard` | Reroute / npm 包 `reroute` |
| `ob` / `outboardd` | `reroute` / `rerouted` |
| `bin/ob.mjs` / `bin/outboardd.mjs` | `bin/reroute.mjs` / `bin/rerouted.mjs` |
| 项目 `outboard.toml` | 项目 `reroute.toml` |
| `~/.outboard/` / 项目 `.outboard/` | `~/.reroute/` / 项目 `.reroute/` |
| `OUTBOARD_*` 环境变量 | `REROUTE_*` 环境变量 |
| Pi 扩展 `outboard.ts` | `reroute.ts` |
| DeepSeek `outboardExecutor` | `rerouteExecutor` |
| 远程目录/资源标记 `outboard` / `ob-` | `reroute` / `reroute-` |

## 已使用旧版的项目

如果还没有使用旧版，直接按 README 安装，不需要迁移。

如果用过旧版，**先用旧版收尾，再切换**：

1. 停止旧 dev/前台任务，使用旧版 `ob sync` 检查同步和冲突。备份本地源码及必要的远程产物；构建缓存等不属于源码同步范围。
2. 检查旧运行时是否仍有账单和保留文件。需要释放托管资源时，用旧版 `ob stop --destroy`；这是破坏性操作，先确认后端语义。SSH 的 destroy 只删除拥有的工作目录，不关闭服务器；Modal volume 可能需要原生单独清理。
3. 用旧版 `ob disable`，并在其他旧项目也停止工作后执行 `ob daemon stop`。不要让两套协调进程同时管理同一份源码。
4. 保存旧 hook/扩展及配置备份。只移除能够确认由旧版安装的 `outboard.ts` 扩展或精确 hook 条目，不重置其他代理设置。旧版没有自动卸载器，PATH 中手动添加的旧 shims 也需要移除。
5. 把共享配置文件改名为 `reroute.toml`，用户配置可复制到 `~/.reroute/config.toml`；把需要的 `OUTBOARD_*` 设置改成 `REROUTE_*`。不要复制旧 `project.json`、同步基线、IPC token 或运行时引用来冒充新状态。
6. 安装 Reroute，执行 `reroute setup --harness ...`，再到项目执行 `reroute enable --provider ...`。这会建立新项目身份和新的远程资源/目录；重启代理后用 `reroute doctor` 检查。

旧版云标签、集群名、工作目录、SDK 安装和代理 hooks 不会被新版自动接管或删除。
同步仍强制排除 `.outboard/` 和 `.outboard-runtime/`，防止迁移期间把旧机器状态当源码传输；这不是自动迁移。
确认旧资源已收尾后再自行清理旧状态目录。不要仅更名 `.outboard/` 就假设完成迁移。
原始交付报告与日志保留旧名称是为了保留证据，见 [DELIVERY.md](DELIVERY.md)。

## OMP 支持移除

Reroute 不再检测、安装或修复 OMP 扩展；不要用 `setup --harness omp` 迁移。
已有 Reroute 扩展请显式执行 `reroute uninstall --harness omp`：只清理当前 home
内有所有权记录且哈希未变的文件，用户修改、符号链接或无记录文件会保留。
默认 uninstall 不选择旧 OMP，doctor 只提示且不会重新安装。保留的旧扩展需备份后
手动审查，只移除确认属于 Reroute 的代码，不删除 `.omp` 或重置用户配置。
详见[代理指南](HARNESSES.md#legacy-omp-migration-no-longer-supported)。
