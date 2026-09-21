# Issue #6：隔离启动与显式初始化验证

范围：[Issue #6](https://github.com/nt1r/FileHop/issues/6)、Spec 001 A01 及 A16/A17 的相关隔离配置部分。不是整个阶段或真实公网验收。

## 实现与测试 seam

- 公开管理命令：`filehop init --username ... --confirm-paths`；测试使用真实伪终端，密码不在 argv，验证终端输出不含合成密码。
- 状态 HTTP interface：`GET /api/status`，实际后端进程 + 临时真实 SQLite/目录；正常启动不创建替代数据库。
- 页面：构建后静态页面 + 真实后端，Playwright Chromium；只在回环随机端口运行。
- 容器：一次性 Compose 项目、无网络/无发布端口、临时挂载；容器内初始化和重建后通过状态 interface 验证挂载数据。

## 初始实现验证（历史记录）

下表记录最初 Python 测试实现的执行证据，不是当前运行命令；当前已迁移至 Rust / Playwright / Bash，命令见开发指南。

环境：Linux ARM64，Rust 1.98.1、Node 24.21.0、npm 11.19.0、Docker Compose v5.5.1；Playwright Chromium 153.0.8010.12。

| 检查 | 结果 |
| --- | --- |
| `cargo fmt --check` | 通过 |
| `cargo clippy --locked --all-targets -- -D warnings` | 通过 |
| `cargo test --locked` | 1 个 HTTP interface 测试通过 |
| `cargo build --locked` | 通过 |
| `python3 -m unittest discover -s tests -v` | 16 项通过 |
| `npm ci`、lint、TypeScript + Vite build | 通过 |
| `python3 tests/browser.py` | 1 个真实后端浏览器闭环通过 |
| 两个 Dockerfile 构建 | ARM64 本地构建通过 |
| `python3 tests/compose_smoke.py` | Compose 内初始化、重建及数据验证通过，临时容器已清理 |
| 开发 Compose `config --quiet` | 通过；没有启动真实开发入口 |
| Caddy 示例 `adapt`、格式检查 | 静态转换通过；未 reload 共享 Caddy |
| `git diff --check`、敏感目录忽略规则 | 通过 |

CLI/HTTP 测试覆盖：全新启动不写数据、显式初始化/重启、运行时刷新、凭证格式及 Unicode 长度、隐藏输入、强制目标确认、拒绝密码参数、重复初始化不覆盖、未知残留、数据库缺失、身份缺失/不匹配、不可写目录/数据库、符号链接数据库、并发初始化、实际受限文件写入引发的部分失败保留，以及业务写入口未开放。

TDD 红绿记录：未初始化状态、显式初始化命令、运行中状态刷新、存储不可写检查、页面闭环均先观察失败，再实现通过；其余用例用于扩充回归。

## 无 Python 测试迁移

- 后端原有 16 项 CLI/存储行为迁入 `backend/tests/initialization.rs`：常规状态通过进程内 HTTP interface，两个权限场景合为一个用例，共 15 个行为测试。公开命令仍以真实 PTY 验证；条件等待终端关闭 ECHO 后才输入，避免提示符与关闭回显之间的竞态。
- `initialize_external_fixture` 是明确忽略的辅助入口，不是未完成用例；浏览器和容器编排显式执行它，调用实际管理命令，不增加产品调试入口。
- `tests/browser.sh` 与小型 Node HTTP fixture 连接真实后端，Playwright 验证页面；`tests/compose_smoke.sh` 保留容器内初始化、重建和两次后端重启后的状态验证。
- `tests/web_container_smoke.sh` 保留递归环境文件排除及非 root、只读挂载下的 Vite 启动/源码转换验证。
- 新路径本地验证通过：Rust fmt/Clippy、15 项初始化行为与 1 项存活测试、显式 fixture 执行、npm ci/lint/build、Playwright 闭环、两个容器构建及两类 Bash 容器冒烟。Shell 使用 `bash -n` 验证，当前环境没有 ShellCheck，未声称执行该检查。
- Python 测试脚本全部删除，应用 CI 与开发命令同步替换；仓库原有 PR 分支策略 workflow 的 Python 不属于应用测试，本次未改动其受信任策略逻辑。
- 不按测试数量机械复制，不扩建通用测试平台。仅新增测试专用 PTY 依赖，应用运行代码未变。

## 两轴自行审阅

基准：实施前 `8cfb3d1`，范围包含前一轮未提交的初始化骨架。当前工具没有子代理能力，未进行独立并行子代理审阅。

### Standards

检查 AGENTS、CONTRIBUTING、testing 的安全/测试/范围要求及 code-review smell baseline。初次检查修正 Docker 构建上下文未排除浏览器 trace/test-results 的问题。PR 整体复审进一步实测发现嵌套 `web/.env*` 未被排除；现已改用递归排除并以合成文件构建/导出验证，不再仅凭规则外观判断。

### Spec

检查 #6 各验收项及 Spec 001 初始化条款。发现并补齐存储不可写时不能报告已初始化、进程启动前诊断、Compose 容器内初始化/重建验证。没有提前增加登录、消息或远程初始化。PR 整体复审进一步发现前端镜像 root 安装依赖后切换 node 用户，导致 Vite 启动 EACCES；已让 node 拥有工作目录并以 node 安装依赖。新增真实只读开发挂载下的非 root Vite 启动、HTML 与源码转换检查，已在本地通过并纳入 CI。此前镜像构建成功不构成容器启动证明。未完成的外部验证见下。

## 未验证与剩余边界

- PR #16 初始提交 `09c5c82` 的 GitHub 托管 CI 已通过，但未覆盖本次复审发现的两项问题；修复后的新增容器/排除回归检查须以对应提交的 CI 结果为准。
- 真实开发 FQDN、HTTPS/Basic Auth/WSS、代理信任链及稳定版桌面 Chrome 验收属于 #13，未修改共享 Caddy、DNS/OCI 或生产配置。
- Argon2id 使用 19 MiB、t=2、p=1；仅完成初始化路径，登录负载、并发验证预算与性能测量随 #7 交付。
- 本地目录锁用于协调本应用初始化命令，不防御有宿主权限的外部进程恶意替换挂载或数据库；后续业务写入须继续维护存储验证，不能把状态页面当作永久授权。
- 不自动恢复部分初始化，不提供备份恢复、初始化撤销或管理密码重置（后者为 #8）。
