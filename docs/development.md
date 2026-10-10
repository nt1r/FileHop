# FileHop 开发指南

本文面向贡献者，说明工程工具链、测试命令及隔离开发运行方式。所有命令均从仓库根目录执行；不是面向终端用户的生产安装指南。

产品介绍见[项目首页](../README.md)，需求见[产品基线](product.md)，实现顺序见[路线图](roadmap.md)。本指南保留既有复验入口，但不是每次改动的必跑清单；以下 Chrome、HTTPS 和阶段复验步骤仅在首次接入、相关风险变更或实际排障时选用。未受影响的既有证据直接复用，执行频率以[测试原则](testing.md)为准。具体机器上的执行结果保留在[验证记录](verification-issue-6.md)，不作为其他环境已经可用的证明。

> 实现状态说明：[Spec 007](specs/007-implemented-flow-simplification.md) A/B/C 已实现：单入口删除与手动刷新、单轮串行上传，以及登录失效后丢弃等待项和全部 File 引用。仅保留草稿和未确认发送信息，重登须手动查询或结束本轮，不自动恢复文件批次；稳定版桌面 Chrome 人工确认仍待完成。

## 文件传输资源与环境验收

在已约定的 HTTP、真实隔离存储和进程资源边界上，可重复执行有限资源检查：

```bash
cargo test --manifest-path backend/Cargo.toml --locked --test files_process bounded_memory -- --ignored --nocapture
bash tests/caddy_ingress.sh
# browser.sh 使用已有 web/dist；必须先构建，不能把缺失静态文件导致的 502 当作 Chrome 不兼容。
pnpm -C web run build
FILEHOP_TEST_CHROME=1 bash tests/browser.sh
```

资源检查仅支持 Linux `/proc`，每组启动独立后端、真实临时 SQLite 及一次性文件目录；先依次准入，再并发传输，避免将正常准入竞争 429 误判为流式失败。组合为 1 MiB × 1、100 MiB × 1、100 MiB × 3；客户端按 64 KiB 块生成和校验内容，不整体缓存文件。输出基线 RSS、内核记录的进程峰值 RSS、增长量与最终实体字节数。峰值包含登录等启动期分配，不是纯传输分配量；不包含内核页缓存，也不证明整台主机的内存预算。检查采用宽松的 64 MiB 增长预算和单路大小变化低于 32 MiB 的预算，以发现整文件缓冲，不将某次测量值作为性能承诺。使用默认 100 MiB / 1 GiB、8 活动任务和 64 MiB 磁盘余量配置；运行前清除会覆盖默认值的 `FILEHOP_*` 传输环境变量。该检查显式执行（普通 cargo test 忽略），仅发布 PR 或手动完整 CI 运行；相关传输变更主动复验，不建设长期压测平台。

资源检查在各文件发送一半时暂停客户端，等待服务端暂存字节达到预期检查点，再继续传输；同时每 1 ms 采样受管实体的逻辑字节数，记录暂存及实体总量的采样峰值。总量按设备号/inode 去重，避免提交期间临时与正式硬链接双计。半程检查点与最终实体总量分别验证在途和完成状态；采样可能遗漏短暂峰值，不证明磁盘分配块、内核页缓存、代理暂存或整台主机占用。失败残留额度另由 `backend/tests/files.rs`、`files_failure.rs`、`files_timeout.rs` 验证；目标环境资源预算仍须单独核实。`files_failure.rs` 还通过只读状态查询验证没有新写请求时的准备过期，以及清理故障解除后的后台重试、实体删除和完整额度重新准入，不用下一次准备触发清理冒充后台证据。隔离 Caddy 测试用每秒进展的上传和附件响应验证超过 15 秒仍可完成；它的上游是 HTTP 探针，不是完整应用，不能代替真实入口、应用 Cookie/Origin 或 Chrome + HTTPS 组合验收。

阶段验收须绑定确切提交；Issue/PR 中引用前序证据并记录本次组合回归，缺项保持待验收。真实入口检查只可在另行授权的隔离数据环境执行：未通过外层认证的页面/API/文件请求应被拒绝；通过外层认证但无应用登录的文件请求仍应被拒绝；有效登录的错误 Origin 写请求应被拒绝。再用受控速率上传、下载持续超过 15 秒的合成文件，确认进度、附件名与内容，并在最新稳定版桌面 Chrome 复验队列、到期重登、停止和退出隐私。浏览器、代理、系统实际版本及环境细节保留私有，公开仅记录兼容类别、提交和结果。不得将自动化 Chrome 回环测试、自签名探针或代码合入写成真实环境验收通过。

## 当前实现状态

当前开发切片支持隔离启动、显式初始化、安全登录恢复、退出及管理员撤销登录，以及文本发送／主动读取／复制、历史分页、未知发送恢复、前台增量同步和桌面多文件队列与附件交换闭环：

- `web/`：Vite + React + TypeScript + Kumo standalone 样式，初始化状态页面、安全登录、受保护的消息工作区、同页重新登录及同源标签页退出通知。工作区支持多选追加、单个活动文件的页面内串行上传队列，以及附件下载。
- `backend/`：Axum + Tokio + SQLx SQLite；显式 `init` / `reset-password` 管理命令、存储标识与账户迁移、`GET /api/status`、Web `POST/GET/DELETE /api/session`、原生 `POST/GET/DELETE /api/native/session`、`POST /api/messages`、最近页、before 历史分页及 after 增量分页 `GET /api/messages`、发送结果 `GET /api/sends/{send_id}`。
- `android/`：Kotlin + Compose 文本客户端，独立原生 Bearer 认证；工具链、官方 SDK 托管构建、安装及签名配置见 [Android 指南](android.md)。真实手机与正式签名验收状态以 Issue/PR 为准。
- `deploy/`：开发应用 Compose、容器构建文件及共享 Caddy 站点示例。
- `GET /internal/live` 仅返回 204，表示进程可响应；**不是数据库可用或业务就绪检查**。`GET /internal/ready` 区分数据库可用及恢复／上传就绪，详见下方内部检查说明；两者均不通过公网入口开放。

状态查询仅返回 `uninitialized`、`initialized` 或 `storage_error`，禁止缓存且不泄露目录、账户或凭证。未初始化与存储异常不开放业务写入。文件多选串行队列、手动状态查询、本地中断、结束本轮与附件下载已实现；同页重新登录刷新有效限制，未知发送仍须手动查询或结束本轮，不自动重传，服务器文件页现提供列表、下载和应用文件额度，服务器删除协议及 Web 文件页单入口删除已实现，Web 已正式自用，Android 文本客户端与原生认证随 Spec 005 交付，真机和正式签名验收尚未完成；初始化成功不代表整个 Spec 001 已完成。GitHub 托管 CI 定义见 `.github/workflows/check.yml`，实际执行结果以对应提交的 Actions 检查为准。

### 服务器文件列表与应用内导航

消息工作区和服务器文件页使用同一会话层的草稿、发送状态及上传调度。切页只切换视图，前台且认证有效时等待项继续接续；刷新／关闭仍不恢复本地队列。文件页进入、返回前台及手动刷新读取最新一页并校正已加载文件状态，可加载更早文件；只展示已提交记录，不扫描磁盘。下载复用原有 HEAD 探测和浏览器附件 GET，不缓冲完整 Blob；仅文件页提供删除确认，文件消息只展示下载和已知状态。应用文件额度通过独立快照展示，进入、手动刷新及返回前台时更新；容量请求使用独立代次防止旧响应覆盖新快照，不以文件状态版本代替容量顺序。

文件页提供已加载记录的文件名搜索和类型筛选；数量与结果不代表服务器全量文件，加载更多仍沿用原分页契约。消息页和文件页共用上传任务展示组件，可在任一页面查看进度、错误和手动处理未确认结果；文件页上传后仍手动刷新列表与容量。

列表契约与版本编码见 [Spec 003](specs/003-server-file-management.md#接口职责)。文件状态及版本保存在消息记录中，所有成功发送回执、结果查询和历史使用同一投影；成功提交状态为可用、版本 `"1"`。下载打开发现单文件缺失、类型或大小异常时，条件更新为存储异常并递增版本；既有启动目录遍历发现的明显异常同样记录。发送成功、历史与原占用不变，不自动修复或补发。权限、I/O、目录不可访问及身份不匹配返回安全的不可用错误，不逐条标记缺失。没有定期全盘扫描或 Hash 校验，启动遍历也不承诺发现目录中已不存在的成功实体。

单文件状态和有界批量查询契约见 Spec 003。文件页、历史及发送回执按文件标识共享单调版本记录；等版本或更低版本不能恢复下载。下载探测失败后查询已知状态，手动刷新、重入和返回前台校正已加载文件，每批最多 100 个，不为校正加载全部历史或改变增量游标。隐藏或认证失效不启动查询，主动退出清除缓存，旧认证周期响应失效；查询失败保留已知状态并提示手动刷新，遵守 Retry-After。异常文件可通过相同 Web 确认流程及 DELETE 协议删除，不提供修复入口。

### 服务器文件删除协议

Web 仅服务器文件页提供删除确认，操作上下文由文件页持有。请求未接受前显示请求处理中，接受后显示“删除处理中，空间尚未释放”，提示手动刷新列表和用量；响应只更新请求反馈，不自动查询进度、刷新容量或联动消息。手动刷新／重入取得完成快照后从文件页移除，历史保留“服务器文件已删除”。未知结果提示手动刷新、不自动查询或重发 DELETE；刷新仍为可用不证明原请求不会迟到执行，当前文件页保留警告和下载阻挡，再次删除须确认。FILE_IN_USE 结束本次流程，不排队删除。切页、认证失效及退出均丢弃删除上下文，旧回调不更新新界面；重入只读取当前快照。消息状态允许暂时滞后，实际下载由服务器裁决。手动读取遵守 Retry-After，容量使用独立快照，不乐观扣减。

复验使用 `web/tests/deletion.ts` 的单入口、未知结果手动刷新、冲突拒绝和清理占用流程，以及 `web/tests/deletion-ordering.spec.ts` 的无删除轮询、删除后分页、迟到删除回调隔离与真实旧响应乱序流程。后者保留历史、发送结果和批量状态的旧响应，在较新删除完成快照到达后放行，验证不能恢复下载或重新插入列表；原自动单文件删除查询用例随轮询退役。`server-files.ts` 保留带草稿／上传队列／未确认发送的切页回归。`server-files.spec.ts` 在独立临时实例中编排它与 `deletion.ts`，不继承初始化大流程中中断上传留下的合法预留；所有原有状态、容量与删除断言保留。可单独运行 `bash tests/browser.sh web/tests/server-files.spec.ts`。浏览器失败时，回环代理最多输出最近 32 条状态查询阶段事件（不含凭证、文件标识或请求体），配合失败 trace 区分请求是否到达代理及是否已返回。稳定版桌面 Chrome 人工复验仍须在已授权的隔离实例上确认文件页指定文件及影响文案、保存副本不变、手动刷新后的清理和容量反馈；记录实际验收提交及结果，不将自动化 Chromium 当作人工通过。

`DELETE /api/files/{file_id}` 的 Web 路径需要有效 Cookie 与精确 Origin；原生路径校验独立 Bearer 的类型、摘要及到期时间，不强制 Web Origin，混合凭证拒绝。实例内仍持有该文件读取句柄时返回 `409 FILE_IN_USE`，不排队；读取结束后必须主动重新请求。HEAD 只检查可用性，不启动流式读取。下载打开与删除接受共用短时准入裁决，已接受删除后新下载返回 `410 file_deleted`；断连、读盘错误及无进展期限结束后释放句柄，不跟踪浏览器最终落盘。

持久接受返回 202 及状态对象，已保存转待清理但总占用不变。重复删除中返回 202，已完成返回 200；未知标识返回 404。后台每轮最多处理 64 个删除，失败沿用 5–60 秒退避，轮转游标避免坏实体长期占住第一页。清理验证受管身份与可访问性，仅删除 UUID 对应实体，不跟随链接或递归删除异常目录；目录同步及条件事务完成后才释放额度。故障时保留删除中，重启继续。历史、发送标识和成功结果永久保留，重放返回当前状态，不重新上传。删除未知结果不得自动重发 DELETE，由用户手动刷新检查状态。

正常启动已初始化实例时在恢复前排他锁定两个既有存储身份文件，避免第二个后端绕过进程内读取裁决；嵌入式 Router 的调用者须自行保证同一存储只有一个应用实例。测试使用真实隔离 SQLite、文件目录及回环 HTTP；`files_process.rs` 覆盖下载竞争、断连、重复进程拒绝和删除持久化边界 SIGKILL，`files_failure.rs` 覆盖清理故障与上传准入。这些后端验证不替代 Web 确认界面、生产部署或原生认证验收。

状态字段在首次发布前整理进 `0001_next_release.sql`，该文件现已随 v0.1.0 冻结；独立 `migrate` 不提供已改写旧开发迁移的兼容转换，不得用清库或重写 checksum 宣称升级成功。历史 checksum 不符且需保留数据的实例不能直接更新。测试仅初始化新的隔离合成实例，未操作任何既有数据目录。

### 服务器文件管理复验入口

此表只导航长期复验入口，不是当前版本的通过记录。阶段结论在 Issue／PR／CI 中绑定实际提交，不能用子任务关闭替代通过；原生认证随 Spec 005 补验。

| Spec 003 验收 | 主要自动化入口 | 验证边界 |
| --- | --- | --- |
| M01–M02 | `files.rs`、`deletion.ts`、`deletion-ordering.spec.ts` | 真实分页及删除后的历史保留、单入口、本地下载副本不变 |
| M03–M05 | `files.rs`、`files_process.rs` | 活动读取冲突、HEAD、真实 TCP 竞争／断连、下载无进展期限；已打开后截短合成实体导致读取失败，释放真实句柄后允许主动删除 |
| M06–M07 | `deletion.ts`、`files_failure.rs` | 未知 DELETE 手动刷新、冲突后不自动删除、清理故障保留占用并后台恢复；浏览器冲突注入不是 TCP 竞争证据 |
| M08 | `files_process.rs` | 持久接受后及实体已删除但最终事务失败时 SIGKILL，重启清理与重复重启不重复释放 |
| M09–M10 | `files.rs`、`files_failure.rs`、`server-files.ts`、`deletion.ts` | 互斥容量分类、并发准入、异常实体及全局存储故障不误释放；列表查询不承诺实时探测磁盘 |
| M11–M12 | `server-files.ts`、`deletion.ts`、`files.rs`、`files_process.rs` | 导航保留发送／丢弃删除上下文、手动状态校正、删除后发送身份重放 |
| M13–M14 | `files.rs`、`server-files.ts`、`deletion.ts`、`deletion-ordering.spec.ts` | Web Cookie／Origin／受管标识、版本及容量乱序、退出隔离；不包含原生凭证 |

下载资源参数见下方单文件后端配置；`files.rs` 验证有界下载槽位及无进展超时，`files_process.rs` 的显式 `bounded_memory` 测试比较不同文件大小和并发的进程内存。清理退避及恢复见上方删除协议与 `files_failure.rs`／`files_process.rs`；这些隔离测试不验证生产磁盘或共享代理预算。人工复验须补充最新稳定版桌面 Chrome 的真实后端列表／分页、下载、确认文案、清理与容量反馈、导航和认证恢复，并私下保存实际运行版本与环境信息。最终验收版本不明或任一适用项目缺证时保持待验收，不宣告完整阶段 2 完成。

## 工具链与本地检查

### 版本维护规则

- 有 LTS 支持线的基础运行时（Java、Node）和 CI 操作系统优先采用仍受支持、与工具链兼容的 LTS；不自动追随最新大版本。Java 统一使用 Amazon Corretto，当前选择与补丁解析限制见 [Android 指南](android.md#工具链与构建)。
- Rust、Gradle、AGP、Kotlin、pnpm 等不统一套用 LTS 要求；选择兼容的正式稳定版，排除 alpha、beta、RC。安全补丁及时评估更新，固定版本不代表长期停止维护。
- 检查与发布采用相同的核心工具链版本配置，同名 Actions 统一版本并固定完整 commit SHA，旁注对应 release tag；升级须审阅上游兼容性和默认行为变化。Action 自带的 Node 运行时不同于项目的 Node 版本。
- 核心工具尽量固定具体版本，应用依赖提交锁文件；下载的 SDK、Gradle、Caddy 等归档校验摘要。Corretto 大版本选择、runner 自带工具、未指定工具版本的 Buildx/BuildKit 和未固定 digest 的容器标签是明确的浮动项，不能据此宣称整个 CI 完全可复现。
- GitHub 托管 runner 固定 Ubuntu LTS 系列（当前 `ubuntu-24.04` / `ubuntu-24.04-arm`），不使用 `ubuntu-latest`；这不锁定 runner 镜像补丁或预装工具。辅助工具先保留托管版本，出现实际兼容或复现问题再单独固定，不建立全工具版本矩阵。
- 工具链与 Actions 更新通过显式提交及相应 CI 验证；涉及依赖、镜像或环境的更新按[测试规范](testing.md)执行完整检查。正式发布不消费 PR 缓存或特权产物；`setup-node` 显式关闭自动包管理器缓存，普通检查的 pnpm 缓存仍由独立步骤管理。执行结果留在 Issue/PR 与 CI 日志，不在本文维护临时通过清单。

### 本地检查

测试使用 Rust / Playwright / Bash，见[测试规范](testing.md)，不需要 Python。Bash 在 Linux 宿主机或 CI runner 上编排，需具备 Node、Cargo、Docker、curl 及标准 GNU 工具；不要求应用镜像提供这些宿主工具。

- Node `24.21.0`（`.nvmrc`），pnpm `12.5.1`（`web/package.json` 的 `packageManager`）。使用随该 Node 版本提供的 Corepack：`corepack enable pnpm`，再执行 `corepack prepare pnpm@12.5.1 --activate`。
- Rust `1.98.1`，rustfmt / Clippy（`rust-toolchain.toml`）；安装后确认 `cargo`、`rustc` 可在开发终端调用。
- Docker Engine 与支持当前配置的 Compose v2+。
- 提交 `web/pnpm-lock.yaml` 和 `backend/Cargo.lock`；CI 与容器安装使用 `--frozen-lockfile`，不维护 npm 锁文件。
- 多 worktree 使用同一用户的默认 pnpm store，各 worktree 独立安装并保留自己的 `node_modules`；不手工共享整个安装目录。默认 store 可能随项目所在磁盘变化，可用 `pnpm -C web store path` 核对；不要假定不同挂载点一定共用一个 store。同文件系统可复用包文件，跨文件系统可能复制。Docker 构建不自动复用宿主 store，Playwright 浏览器缓存也独立管理。
- 不无条件放开依赖安装脚本。新增或升级依赖若需要构建脚本，审阅后按当前 pnpm 支持的配置显式批准，再验证干净安装和容器运行；本次依赖无需额外放行即可构建。

从仓库根目录执行，不需要数据库、账户或公网端口：

```bash
pnpm -C web install --frozen-lockfile
pnpm -C web run lint
pnpm -C web run build
cargo fmt --manifest-path backend/Cargo.toml --check
cargo clippy --manifest-path backend/Cargo.toml --locked --all-targets -- -D warnings
cargo test --manifest-path backend/Cargo.toml --locked
cargo build --manifest-path backend/Cargo.toml --locked
pnpm -C web exec playwright install chromium
bash tests/browser.sh
# 每个 spec 独立初始化后端，避免多个场景合计触发上传准入上限；也可单独复验。
bash tests/browser.sh web/tests/deletion-ordering.spec.ts
# 仅验证示例配置；不创建网络、容器或数据目录。
docker compose --env-file .env.example -f deploy/compose.dev.yml config --quiet
```

测试通过公开 CLI（伪终端隐藏输入）、状态 HTTP interface 和浏览器页面验证 S001-A01。使用 Rust tempfile / Bash mktemp 临时目录、真实 SQLite 和回环随机端口；无需真实账户或开发域名，不以假数据库证明一致性。测试仅支持 Linux，权限用例须以非 root 用户运行。浏览器使用 Playwright Chromium，不代替正式稳定版 Chrome/HTTPS 验收。

可选的隔离容器检查（不发布端口、不加入共享网络）：

```bash
docker build -f deploy/backend.Dockerfile -t filehop-issue6-backend .
docker build -f deploy/web.Dockerfile -t filehop-issue6-web .
bash tests/compose_smoke.sh
bash tests/web_container_smoke.sh
```

如本机已有同名镜像，使用本次验证专属标签构建，并通过 `FILEHOP_BACKEND_IMAGE`、`FILEHOP_WEB_IMAGE` 指定给冒烟脚本；未设置时沿用上例标签。验证后仅删除本次专属标签，不覆盖或清理已有镜像。

前端冒烟验证根目录及嵌套 `.env*` 文件不进入构建上下文，并以非 root 用户、实际开发只读挂载启动 Vite，检查 HTML 与源码转换响应；不发布端口。

后端冒烟验证未初始化容器重建不创建数据、Compose 内隐藏输入初始化，并在正常重启、SIGKILL 后启动及保留挂载重建后，通过实际容器的 HTTP API 验证消息、发送标识、有效登录和固定到期时间保留，同标识重放不重复。探测使用已构建 Web 镜像中的 Node，共享该测试容器的网络命名空间，不发布端口、不加入共享网络，也不向应用镜像安装工具。两个镜像均须从待验收提交构建，不能拿旧镜像的结果证明新提交。

测试容器使用调用者 UID/GID，数据库、文件目录和合成凭证仅在一次性目录内，结束后核对路径并清理；不代表生产部署、真实主机掉电、磁盘损坏恢复或文件持久化验收。

## 隔离生产形态运行

本节交付 Spec 004 的生产基础，不是正式部署、发布或更新工具。仅在一次性隔离环境使用；不自动修改共享入口、网络、DNS 或 GitHub 设置。GHCR 发布和手动更新工具见[发布与手动更新](production.md)；独立迁移与内部就绪检查见[已有实例迁移与内部检查](#已有实例迁移与内部检查)，不能拿此配置直接升级需要保留的旧实例。

### 构建及一次性验证

```bash
docker build -f deploy/backend.Dockerfile -t filehop-isolated-backend .
docker build -f deploy/web-production.Dockerfile -t filehop-isolated-static .
FILEHOP_BACKEND_IMAGE=filehop-isolated-backend \
FILEHOP_PROD_WEB_IMAGE=filehop-isolated-static bash tests/production_smoke.sh
```

需 Docker、Compose、Cargo、Node/pnpm、已安装的 Playwright Chromium、Caddy、OpenSSL 和 GNU 工具。使用本次专属镜像标签，勿覆盖既有部署镜像。CI 仅在 GitHub 托管 runner 构建和验证，不发布镜像、不连接 VPS。静态制品为 scratch 镜像，只有 `/web` 构建产物，没有 Node 或可运行服务；用 `docker create <image> /unused` 建立停止的提取容器，再 `docker cp <container>:/web/. <new-directory>`，最后移除该提取容器。镜像没有默认命令是有意设计，不用 `docker run` 提取。

冒烟使用唯一 Compose 项目及两个专用 internal 网络、真实默认 UID/GID 10001、权限 0700 的一次性挂载；通过目标镜像 PTY 隐藏输入初始化。生产与开发测试栈使用不同账户和存储身份。入口仅绑定回环随机 HTTPS 端口，Caddy 使用本次生成的证书；Node 显式信任该证书，Chromium 仅豁免该证书公钥，不设置全局忽略 TLS 错误。该信任方式只服务隔离测试，不是公网证书方案。此容器重建冒烟的 Chromium 固定使用 HTTP/1.1：宿主虚拟接口变化会触发 Chromium 关闭 HTTP/2 会话，使无关的回环请求报 `ERR_NETWORK_CHANGED`。不重试业务操作、不关闭证书校验；生产 Caddy 仍支持 HTTP/2，此冒烟不作为 HTTP/2 的实际使用证据。

测试覆盖：静态资源实际提取和加载、缺失资源 404、生产无开发 Basic Auth、开发仍受保护、未认证拒绝、浏览器文本及附件往返、开发不能使用生产账户/Cookie、开发历史为空、后端及入口进程重建后原会话和消息/附件保留、缺失/空/错配挂载拒绝、默认运行身份及目录权限、无后端端口发布、实际日志驱动及轮转参数。入口为独立宿主进程且静态根目录与业务数据分离，不配置数据库或附件文件服务路径。测试不重复全部业务边界，不证明公网 ACME、真实到期续签、正式 Chrome 或实际生产部署通过。

### 显式配置与操作约定

`deploy/production.env.example` 是占位变量说明，实际配置保存在仓库外。项目名、镜像、精确 HTTPS Origin、代理 IP、专用网络名及两个**绝对**挂载路径均须显式填写，不能指向开发目录或共享开发网络。Compose 的路径插值不代替操作者核对绝对路径；手动使用 Compose 时须自行校验；更新工具接受独立 JSON 配置并核对绝对路径与真实挂载，见[运行指南](production.md)。正式产物按 digest 使用。

`deploy/compose.production.yml` 仅运行后端，保持 `backend:8080`、`/data/database/transfer.db`、`/data/files`；入口使用唯一 `filehop-prod-backend:8080` 别名，开发使用 `filehop-dev-backend`。宿主入口须改用各专用网络的内部地址，不能依赖 Docker DNS；同步设置精确受信代理地址。生产不继承开发外层凭证。`deploy/caddy-production.routes` 使用 `FILEHOP_PROD_BACKEND_UPSTREAM` 与 `FILEHOP_PROD_WEB_ROOT`，后者只指向完整提取的静态版本目录，并由入口只读使用；容器入口只挂该目录，不挂数据库或上传目录。全局 443-only、TLS-ALPN-01 和共享入口操作边界仍见 [宿主入口指南](host-ingress.md)；本任务未应用这些设置。

以已准备且确认可丢弃的隔离目录为例（所有路径和名称均为占位）：

```bash
# 先准备独立网络、配置和两个全新目录，由操作者设置 UID/GID 10001 可写。
# 对首次安装，必须在启动服务之前通过目标镜像显式初始化。
prod=(docker compose --env-file /srv/filehop-isolated/production.env \
  --project-directory /srv/filehop-isolated -p filehop-isolated \
  -f /srv/filehop-isolated/compose.production.yml)
"${prod[@]}" config --quiet
"${prod[@]}" run --rm backend init --username your_admin --confirm-paths
"${prod[@]}" up -d --no-build
"${prod[@]}" ps
"${prod[@]}" logs --tail 100 backend
"${prod[@]}" restart backend
# 保留挂载重建；不是升级命令。
"${prod[@]}" up -d --no-build --force-recreate
# 重置密码撤销全部会话，不删除消息/文件。
"${prod[@]}" exec backend filehop reset-password
```

不要在已有或损坏实例上重新 `init`。生产 `serve --require-initialized` 在监听前检查已有存储身份；空目录、部分初始化或身份错配均退出，不创建替代库；缺失 bind source 由 Compose 拒绝自动创建。开发 `serve` 仍允许安全的未初始化诊断。启动会先完成既有文件恢复再监听；`/internal/live` 仅表示存活，`/api/status` 仅表示存储初始化状态，二者都不能独立证明全部上传就绪。内部路径不经 Caddy 暴露。

应用配置 `restart: unless-stopped`，异常退出由 Docker 重启，人工 stop 后保持停止；SIGTERM 最多等待 30 秒，届时仍未退出可被终止，未确认传输遵循原结果查询规则。**unhealthy 不等于自动重启**：Docker 重启策略响应进程退出，不响应健康标签；当前 Compose 未配置 healthcheck；须通过受控内部 `/internal/ready` 检查恢复／上传就绪，并验证真实业务。错误挂载可能导致重启循环，应先停止、核对挂载与日志，不删除数据或反复初始化。

后端 stdout/stderr 可通过 Compose logs 查询，json-file 每文件 10 MiB、最多 3 个文件，由 Docker 执行轮转；入口运行日志由独立入口服务管理，不随应用更新删除。冒烟核对实际日志配置及可查询启动日志，不通过灌满日志证明整个磁盘预算，也不记录正文、密码或 Cookie。静态 index 使用 `no-cache`，丢失脚本返回 404，不用 SPA fallback 掩盖不完整制品。数据仍为服务器明文存储，无备份恢复或自动回滚承诺；保留挂载只覆盖正常容器生命周期，不覆盖磁盘损坏。普通运行不执行删除数据卷的命令。

## 固定开发部署的管理入口

长期运行的开发站点应使用固定目录中的源码快照或专用普通 clone，不从可删除的 linked worktree 部署。`web/src` 是运行中的只读 bind mount，删除宿主源码会导致页面模块加载失败；数据库和文件目录也不能随 worktree 清理。固定目录仍需由操作者保留，脚本无法防止运行期间的外部删除。

仓库提供统一入口 `scripts/dev.sh`，由 Compose 协调前后端，不分别维护两个启动脚本。目录、入口类型和动作都可省略：

```bash
# 默认识别已有 filehop-dev 项目的目录和 host/container，完整部署当前分支的前后端。
# 包含当前工作区未提交修改；可能停机，执行前保存草稿、结束传输。
bash scripts/dev.sh
# 仅启动已部署版本，不更新源码（不能用于失败迁移后的自动恢复）。
bash scripts/dev.sh start
# 仅有 UI 变更且构建输入一致时，可选择轻量同步。
bash scripts/dev.sh sync
bash scripts/dev.sh status
bash scripts/dev.sh stop
# 路径为示例，替换成操作者确认的固定开发目录。
bash scripts/dev.sh /srv/filehop-dev host check
```

从代码仓库调用脚本，参数指向固定部署目录；两者可以分离，无需向部署目录复制另一套管理脚本。选择与现有入口一致的模式：`host` 使用宿主 overlay，`container` 使用基础 Compose。省略目录时从已有项目识别；没有项目时须显式提供目录。省略模式时从已有项目配置判断；没有项目时按部署目录是否存在 `compose.host.yml` 判断。项目名固定为 `filehop-dev`，每个 Docker daemon 仅管理这一套开发栈。

`sync` 只覆盖部署目录中被只读挂载的 `web/src`、`web/index.html` 和 `web/vite.config.ts`，然后用已有镜像拉起服务并重启前端；不构建镜像，不迁移数据，也不改动 `.env` 或 `data-dev/`。复制前拒绝 Web 写入目标中的符号链接别名，以及目标与数据库、附件目录或 `.env` 的重叠（包括相互嵌套）。后端源码、迁移、Cargo manifest/锁文件、前后端 Dockerfile、Web manifest/锁文件须与固定部署快照一致；缺失或有差异时，在写入前拒绝轻量同步，提示走完整更新流程，不自动升级或绕过检查。这是保守的构建输入检查，不是 API 兼容证明，也不能证明已有镜像确实来自该快照；完整更新时仍须核对镜像与源码一致，不能只复制构建输入来骗过检查。

省略动作等同 `deploy`：锁定固定开发目录，从调用脚本所在仓库创建当前分支的源码快照（含未提交修改、非忽略的新文件，排除 `.env*`、依赖和构建缓存），构建前后端镜像。构建成功后停止旧服务，使用目标后端镜像及原数据挂载运行独立 `migrate`；迁移成功后同步前后端应用输入、保留 `.env`、`data-dev/` 和本地记录，重建两服务容器，限时检查内部后端就绪和前端入口模块。网络、Compose 挂载和入口配置沿用既有配置，Compose 有差异需另行审阅，脚本不修改 Caddy 或网络。

构建失败不停止旧服务；迁移失败保持服务停止，不同步新前端、不自动回滚或启动旧后端，不执行 `init`、清库、改写 checksum。启动检查失败保留数据和日志并报告失败。当前开发库若依赖曾被改写的迁移，自动部署仍会被真实迁移校验拒绝，必须人工解决兼容性，不能用重新初始化绕过。

显式 `start` 仅启动已有镜像；`stop`、`status` 和 `check` 不复制源码。显式 `sync` 遇到 `Full development update required` 时用无参调用或 `deploy` 更新完整前后端，而不是绕过检查。首次账户初始化仍由操作者单独执行。Docker 项目枚举失败即退出，不当作空项目继续操作。操作前核对同名项目所有容器（包括已停止容器）的部署目录、入口配置、服务及实际挂载；不匹配时拒绝操作，迁移必须另行确认。检查与操作之间仍需避免其他操作者并发修改该项目。路径检查细节以脚本为准。配置或目录损坏导致管理命令拒绝执行时，先核实项目归属再直接用 Docker 诊断，不能自动补建目录掩盖数据缺失。

执行前确认 Docker context 和 Shell 中的 Compose 配置变量指向目标开发实例；Shell 同名变量可覆盖 `.env`。`check` 通过只表示路径和 Compose 配置合法，服务健康和数据状态仍须复验。

### 初次准备与后续更新

1. **准备**：初次部署按[环境接入](#开发运行需先完成环境接入)落实网络、配置和目录权限；宿主入口另读[宿主入口指南](host-ingress.md)。更新已有实例时，先取得授权并核对现有挂载、数据和数据库结构兼容性。使用目标镜像的独立 `migrate` 命令；历史 checksum 不兼容时停止更新，不能用 `init` 或清库替代。
2. **构建**：在维护窗口停止已有服务，仅替换受版本管理的源码，保留 `.env`、`data-dev/` 和本地运行记录；避免全目录删除或清理。完成条件是两个镜像均由目标源码构建，而非仅存在同名镜像。可用本地 `DEPLOYED_COMMIT` 记录 SHA，记录本身不证明镜像版本。
3. **复验**：启动后验证页面入口模块、API、外层认证及预期数据状态，再完成浏览器复验。已有实例变为未初始化时停止验收并调查数据，不创建替代账户。

脚本和测试纳入版本管理；实际配置、凭证、数据库、文件和 `DEPLOYED_COMMIT` 留在部署目录，不提交。

本地验证：`bash tests/dev_script.sh` 检查公开 CLI、无参完整部署及参数省略、构建/停服/迁移/启动顺序、构建与迁移失败的停止边界、Docker 枚举失败（含部分输出）、路径别名/数据重叠、轻量同步的构建输入差异及拒绝时无写入/生命周期操作（使用假 Docker 和一次性合成目录，不接触运行栈）；真实 Compose 配置和容器能力由既有配置检查与隔离冒烟验证，不把 CLI 测试当作容器启动证据。

## GitHub Actions 检查分层

`.github/workflows/check.yml` 保留单个 `initialization` job，在 GitHub 托管 runner 上按事件选择检查范围：

| 事件 | 基础应用检查 | 隔离 HTTPS 入口 | 镜像构建与容器冒烟 |
| --- | --- | --- | --- |
| 纯文档 PR → dev（严格白名单） | 跳过 | 跳过 | 跳过 |
| 其他 PR → dev | 运行 | 跳过 | 跳过 |
| dev → main 发布 PR | 运行 | 始终运行 | 始终运行 |
| push → dev/main（包括合并后） | 不再触发 Application checks | 不触发 | 不触发 |
| Actions 手动运行（workflow_dispatch） | 运行 | 始终运行 | 始终运行 |

基础应用检查包含 Rust fmt/Clippy/测试/构建、Web lint/TypeScript/构建、现有真实后端浏览器回归、Shell 语法和 Compose 配置校验。有限内存测量移到发布 PR 或手动完整检查；不再按源码路径选择环境检查。Rust 静态检查、集成测试、资源回归、构建，以及 Web 安装、构建、浏览器安装分别计时。隔离 HTTPS 与容器检查属于运行环境验证，不是生产发布。

检查范围由 `scripts/ci-scope.sh` 决定。开发 PR 使用 base/head 的 merge-base 差异检查整个 PR，而非仅最后一次提交；关闭重命名检测以同时覆盖旧路径删除和新路径添加。分类失败直接使 job 失败，空差异保守执行应用检查。所有运行（包括纯文档 PR）都执行 `bash tests/ci_scope.sh`，通过临时 Git 仓库验证事件、整个 PR、删除、重命名及无效输入边界；不使用顶层 paths-ignore 跳过必需检查。保留 `initialization` job 名称和默认失败传播，不增加 always-success 汇总或 continue-on-error；必需步骤失败或运行取消不会变成合法跳过。workflow 未改变 GitHub 保护规则，实际门禁设置仍须另行核实。

- 纯文档白名单仅包含根目录 `README.md`、`CONTEXT.md`、`CONTRIBUTING.md`、`AGENTS.md`、`LICENSE`，`docs/` 下 Markdown 和 PR 描述模板。必须整个差异都在白名单内；未知路径和混合源码变更执行应用检查。发布 PR 和手动完整检查不使用文档豁免；PR 来源策略不变。若文档未来成为构建输入，必须同步移出白名单。
- 容器、代理、迁移、依赖或构建配置变更，合并前主动运行手动完整检查；不维护细粒度路径分类表。发布 PR 始终运行环境及资源检查。
- Caddy 仍验证认证、头处理、路由和超过 15 秒的传输，不缩短测试来制造提速。

普通业务变化也可能产生容器特有问题；默认延迟到发布 PR 检查。有相关风险时，在 Actions 的 Application checks 中选择对应分支手动运行完整检查（手动入口需先存在于默认分支），不要把基础检查成功当作容器路径已验证。并发组按 workflow、事件类型和 ref 隔离，手动完整检查不会被其他事件取消；同一事件类型与 ref 的新运行仍会取消旧运行。

当前镜像仅加载到 runner 用于测试，不推送 GHCR、不部署；开发 Web 镜像运行 Vite，独立的 `web-production.Dockerfile` 交付可提取静态制品。容器检查还运行生产形态 HTTPS 冒烟，因此选中容器检查时也准备 Caddy 并执行既有入口检查。正式版本 tag 的 ARM64 构建与发布由独立 `release.yml` 实现，前置授权、公开检查及实际发布限制见[运行指南](production.md)。PR 来源策略仍由独立的 `.github/workflows/pr-policy.yml` 检查。

## GitHub Actions 缓存

`.github/workflows/check.yml` 在所选检查范围内复用以下缓存；缓存命中不代替相应安装、构建或测试：

- pnpm：Corepack 启用固定版本后，在 `web/` 中查询实际 store 路径，通过 `actions/cache` 保存下载内容，不缓存 `node_modules`。键区分 OS、架构、Node/包管理器配置和锁文件；锁文件变化时可恢复兼容的旧下载内容，再由 `--frozen-lockfile` 补齐。
- Cargo：`Swatinem/rust-cache` 缓存下载与 `backend/target` 中的依赖编译产物，不缓存工具安装目录。键区分 runner OS/架构，并由 Action 纳入实际 Rust 编译器、相关环境变量、工具链文件、Cargo manifest 和锁文件。
- Docker：Buildx 使用 GitHub Actions v2 缓存后端，前后端按 OS/架构使用独立 `checks-*` scope，`mode=max` 包含中间构建层；工具链镜像、锁文件与源码变化由 BuildKit 层摘要判断。镜像不推送仓库，通过 `load: true` 加载到本次 runner，继续运行现有容器冒烟。

这些缓存仅用于检查，不作为发布制品或未来特权发布的可信输入。GitHub 将 PR 写入的缓存限制在该 PR 的 merge ref，PR 可读取可见的基分支缓存，不能将其写回基分支。未来发布流程不盲目信任不可信 PR 的缓存或产物，使用受保护提交和最小发布权限，不建设额外准入体系。缓存内容不得包含凭证、数据库或真实用户文件。

dev/main 的 push 不再触发 Application checks，因此不会刷新对应分支的 Docker 缓存；PR 写入的缓存也不会自动成为后续其他 PR 可复用的基分支缓存。依赖、工具链或基础镜像有较大更新后，如需改善后续 PR 的容器构建耗时，可在合入 dev 后选择 dev 手动运行一次完整检查，刷新其 Docker 缓存。这是可选的性能维护，不是正确性门槛；不为预热缓存恢复每次 push 的镜像构建。

首次运行、依赖/工具链更新或缓存被淘汰后仍可能下载；缓存命中也仍执行安装与正确性检查。宿主 Cargo/pnpm 缓存与 Docker 构建缓存互不共享。后端 Dockerfile 在复制业务源码前，按固定 manifest/锁文件和当前隐式 lib/bin 目标编译依赖，再用 `cargo clean --release --package backend` 删除应用占位产物。业务源码或迁移变化只重新执行应用编译层；依赖层通过既有 BuildKit `mode=max` 跨运行复用，不依赖未导出的 cache mount。新增 Cargo target、build.rs、路径依赖或 workspace 时必须同步调整此层，不能把占位构建当作真实应用检查。冷缓存仍执行完整依赖和应用构建。Playwright 浏览器和 Linux 系统依赖暂不缓存；默认 headless Chromium 检查使用 `playwright install --with-deps --only-shell chromium`，不下载未使用的完整 Chrome。稳定版 Chrome 人工验收仍需单独安装对应浏览器，不受此优化替代。Caddy 仅在入口检查被选中时下载，仍执行固定 SHA-512 校验；不新增工具缓存。

需要调查缓存问题时，对发布 PR 复跑或对同一提交手动运行两次完整检查：两次完整检查都应通过；第二次 pnpm/Cargo 步骤应报告缓存恢复，Docker 应出现缓存导入及适用层的 `CACHED`，且两个容器冒烟仍执行。需要强制冷缓存时，在临时测试分支更换缓存键前缀和 Docker scope，不删除共享缓存。实际命中率与耗时以对应运行日志为准，本地静态校验不能代替此验证。

## 开发运行：需先完成环境接入

开发者连接 VPS；浏览器仅使用开发域名的 HTTPS/WSS 443。不要直接在 VPS 执行 `cargo run` 或将 Vite 端口映射到公网。本工程不自动接入现有 Caddy、不自动创建网络、不修改防火墙，也不启动第二个入口抢占 443。

1. 将 `.env.example` 复制为 `.env`，填写完整开发域名及**专用开发网络**名称。示例 `.invalid` 域名不能用于真实接入。
2. 经操作者确认后，为开发栈建立网络并让共享 Caddy 加入。生产与开发不得共用应用网络；开发代理别名为 `filehop-dev-backend` / `filehop-dev-web`，应用内后端仍为 `backend:8080`。
3. 确认仓库所在绝对路径后，建立 `data-dev/database`、`data-dev/files`。后端容器以 UID/GID `10001` 运行，显式初始化需要这两个目录可写；由操作者设置目录权限，不使用 `chmod 777`。Compose 拒绝自动创建缺失的挂载目录。
4. 审阅 `deploy/Caddyfile.dev.example` 并整合至共享入口。开发域名、独立 Basic Auth 用户及密码哈希由 Caddy 的受控本地配置提供；应用 `.env` 不会自动传给共享 Caddy。真实密码与哈希均不提交 Git。Caddy 转发前移除外层 Authorization；外层错误带 `X-FileHop-Access-Layer: development`，客户端后续不得将其误认为应用会话失效。
5. 共享入口全局配置须关闭自动 HTTP 跳转（`auto_https disable_redirects`），仅发布 TCP 443，使用 TLS-ALPN-01；示例禁用 HTTP-01。修改共享全局配置会影响其他站点，须单独审阅授权。确认 DNS/CAA、云平台 规则和实际可达性，不能通过忽略证书检查验收。
6. 配置校验及授权完成后，才在根目录执行：

   ```bash
   docker compose --env-file .env -f deploy/compose.dev.yml config --quiet
   docker compose --env-file .env -f deploy/compose.dev.yml up --build -d
   ```

浏览器访问 `https://<开发域名>`，先通过开发外层认证。HMR 经同域 WSS 443，源文件只读挂载供热更新；依赖变更需重新构建。Compose 不发布前后端端口，Caddy 不挂载数据库或文件目录。

使用独立宿主入口时，按[宿主入口指南](host-ingress.md)配置 Compose overlay 和独立服务，不直接套用容器 Caddy 网络示例。开发入口验收证据见 [Issue #13](https://github.com/nt1r/FileHop/issues/13)。

**以上是操作说明，不代表网络、域名、Caddy 或真实账户已经配置。** 普通运行不会创建数据库或账户，不能用 `sqlx database create` 代替显式初始化。

迁移编号、`main` 冻结、checksum、开发数据与发布关联规则见[数据库迁移维护规则](../backend/migrations/README.md)。已有实例使用下述独立迁移命令，不能用 `init` 代替升级。

### 已有实例迁移与内部检查

先核对目标版本、两个绝对挂载目录、UID/GID 和存储身份；生产须在已授权的维护窗口结束传输并停止旧后端，确认没有其他进程写同一实例；允许入口暂不可用，不要求独立维护状态机。以下是目标镜像的独立调用契约；手动更新脚本及发布记录见[运行指南](production.md)，不建设持久维护开关。不要从开发工作区编译的程序迁移生产：

```bash
# 变量由操作者从受信发布信息和本地配置明确提供；目录必须已经存在。
# TARGET_BACKEND_IMAGE 必须是目标镜像的完整 digest 引用，而非 latest。
docker run --rm --network none --user "$FILEHOP_UID:$FILEHOP_GID" \
  --mount "type=bind,src=$DATABASE_DIR,dst=/data/database" \
  --mount "type=bind,src=$FILES_DIR,dst=/data/files" \
  "$TARGET_BACKEND_IMAGE" migrate
```

成功退出 0 并输出 `Migration completed.`；不创建账户、不做文件恢复。缺库、缺身份、身份不一致、账户缺失、迁移历史缺失、checksum 不符、dirty 或未知版本均拒绝。后端、迁移、第二个迁移不能并发使用同一实例；进程退出释放锁，不需删除锁文件。密码重置也不能与迁移并发。空目录仅供显式 `init`，不能用迁移代替首次初始化。

失败退出非零，stderr 给出错误及人工检查提示。停止后续更新、不启动旧后端写新结构，核对目标镜像和挂载、运行中的旧进程、权限／空间以及 `_sqlx_migrations` 实际记录；不要修改 checksum、删除身份文件、清库或自动重复运行。这里只实施迁移，不保证任何错误都能无条件事务回滚，不定义跨版本组合支持政策。v0.1.0 的 `0001` 已冻结；新增 `0002_next_release.sql` 保留 Web 会话并区分原生类型；后续迁移继续递增编号并保留 `_next_release.sql` 后缀，发布时不改名。`backend/tests/migration.rs` 用冻结初始迁移建立合成实例验证升级后的账户、文本及 Web 会话保留，不代表生产已升级。改写过的开发版 `0001` 不会被自动修复。

迁移成功后用同一目标镜像和挂载启动后端，通过本机或受控内部网络访问：

- `/internal/live`：204，仅表示 HTTP 存活。
- `/internal/ready`：JSON `{ "database_available": true, "uploads_ready": true }`；全部就绪时 200，否则 503，始终 `Cache-Control: no-store`。数据库不可读时前项为 false；文件身份／访问异常或恢复未完成时后项为 false。不返回路径、账户或错误详情，也不新增“待清理就绪”分类；已有删除清理不阻断其余可用额度。
- `/api/status`：仍仅描述初始化状态，不能作为发布开放条件。

CLI 在文件恢复完成前不监听，因此恢复中的连接失败不能视为存活；嵌入式 Router 可先提供读取／诊断，恢复前上传准入返回 503。失败恢复不能用 live 成功冒充 ready。检查是瞬时状态，不承诺下一次上传有足够额度或磁盘空间。内部路径不得被 Caddy 公开代理；现有开发与生产路由均封锁 `/internal/*`。容器镜像不含 curl；可从获授权的宿主／内部探针访问，不为探测安装工具或开放公网端口。Docker 的 unhealthy 本身不会触发自动重启，不应把重启策略当成失败迁移的恢复办法。

复验入口：`backend/tests/migration.rs`（命令拒绝及双向进程互斥）、`health.rs`（就绪与上传准入）、`files_process.rs`（命令后账户、文本、发送身份及真实文件保留）。全部使用隔离合成数据；不替代目标生产镜像、真实发布升级或入口维护验收。

### 显式初始化

确认开发数据目标目录全新、可写且彼此独立，然后执行（命令显示目标路径，密码通过终端隐藏输入，不接受密码参数）：

```bash
docker compose --env-file .env -f deploy/compose.dev.yml exec backend \
  filehop --database-dir /data/database --files-dir /data/files \
  init --username your_admin --confirm-paths
```

`--confirm-paths` 表示操作者已确认上述两个路径；不代表允许覆盖。用户名为 3–32 个 ASCII 字母、数字、`_`、`-`，保存时转小写；密码为 12–128 个 Unicode 码点，不 trim。初始化成功后在页面点击“刷新状态”，无需重启后端。

单文件后端配置：`FILEHOP_MAX_FILE_BYTES` 默认 104857600、`FILEHOP_FILE_QUOTA_BYTES` 默认 1073741824；`FILEHOP_TRANSFER_ACTIVE_LIMIT` 默认 8（分别限制同时上传、下载和准备请求）；`FILEHOP_DISK_RESERVE_BYTES` 默认 67108864。未开始的准备与最近一小时的申请记录合计最多 64 项（也覆盖零字节申请），满额或准入竞争时返回 429，不排无限等待队列。准备请求体最多 8 KiB、读取期限 15 秒；`FILEHOP_PREPARE_TIMEOUT_SECS` 默认 120，`FILEHOP_UPLOAD_IDLE_SECS` 默认 120，`FILEHOP_UPLOAD_TOTAL_SECS` 默认 1800，`FILEHOP_DOWNLOAD_IDLE_SECS` 默认 120。下载每条活动流最多缓存两个 64 KiB 块；后台清理默认每 5 秒协调最多 64 项，失败退避至 60 秒。这些参数以小型 VPS 上有限并发、保留 64 MiB 磁盘余量为起点，不代替目标机器的实际空间及内存验证；桌面上传现使用 XHR 直接发送 File，实时显示上传字节进度，数据到 100% 后仍等待提交响应；控制请求设 15 秒期限，上传体期限从认证 `/api/transfer-limits` 返回的 `upload_total_timeout_seconds` 读取，再加 60 秒等待响应余量（默认合计 31 分钟）；未知、缺失或非法期限暂停新上传，已开始的 XHR 不追溯调整。服务端 `FILEHOP_UPLOAD_TOTAL_SECS` 允许 1–4294907 秒，以保证毫秒期限不溢出 XHR uint32；超时只说明结果未确认。整体期限限制接收及进入提交前的资格，底层写入收尾和提交不能被强行取消。下载交给浏览器原生管理器，不配置截断持续进展下载的固定整体期限；后端 download idle 仅覆盖读盘/响应背压，不承诺跟踪浏览器最终落盘。

Caddy 的 `FILEHOP_PROXY_CONNECT_TIMEOUT` 默认 `5s`，`FILEHOP_PROXY_RESPONSE_HEADER_TIMEOUT` 默认 `60s`，在 Caddy 环境中设置，非应用 Compose 的环境变量。后者从向上游发送完请求体后等待响应头起算，不是上传全程或下载响应体期限；等待提交超时仍须查询发送结果。`tests/caddy_ingress.sh` 用 1 秒首响应期限验证无响应头上游被拒绝，同时持续超过 15 秒的双向文件体仍成功。浏览器到代理的连接及原生下载期限由 Chrome 管理，页面不能直接配置。修改仓库配置不表示已修改运行中的共享入口；实际应用须另行授权。

选择前及选择后重新查询有效单文件限制；未知/离线不启动上传。多选及追加后按选择顺序串行发送，等待项不申请服务器额度且可单独移除。成功或明确失败后继续下一项；失败后须重新选择，产生新的 send_id，不存在文件同次重试或后继传输。文本输入与发送独立。刷新后不恢复任务，重新选择前应先检查历史。

中断传输只 abort 当前本地准备/文件体请求，不撤回服务器任务，也不释放服务器预留。结果未知时暂停整条队列，只能手动查询或明确结束本轮；即使恢复网络、回到前台、重查限制或重新登录，也不会自动查询未知发送。查询到仍在准备/写入或 404 均保持暂停；确认成功或终结失败后才继续等待项。清理中的失败实体仍占额度。结束本轮会确认重复风险，清除全部上传队列与任务上下文，不再协调旧发送；后续历史读取仍可展示真实成功消息。

登录到期或接口确认登录失效时，只中断本地请求，不调用服务器停止；服务器仍可能保存已接收的文件。等待项、已终结任务与全部 File 引用立即丢弃，页面提示等待文件需重新选择。只在当前页面内存保留草稿和未确认发送的身份／展示信息，未登录时隐藏；同页重登后手动查询或结束本轮，不自动查询、重传或接续旧队列。查询确认成功后，原等待文件仍须重新选择。主动退出及同源退出通知清空全部敏感上下文；结束本轮后上下文也不恢复，旧准备／上传／查询响应不能复活任务或操作新批次。文本草稿与同次重试规则不变，不自动发送。

后端仅保留准备、内容上传、发送查询与下载；`POST .../attempts` 和 `POST .../stop` 路由已移除，旧请求返回 404，不转换为新发送。更新前保存输入、结束传输，更新后刷新客户端。沿用既有数据库结构，不修改已应用迁移；旧控制表只读保留，拒绝重新使用旧控制身份，启动恢复安全终结旧未提交记录。既有账户、消息、成功身份、下载及容量清理保护保持不变，不清库、不重写 checksum。历史 checksum 已不匹配的开发实例仍不能借本次更新自动修复。

复验入口：`web/tests/files.ts` 验证串行、多选、文本独立、失败重选和下载；`upload.spec.ts` 验证未知暂停、手动查询、本地中断及结束本轮；`file-session.ts`、`file-logout.ts` 验证 R05 到期及接口失效后的丢弃提示、草稿保留、手动查询不接续、结束本轮／退出清理、迟到准备／上传／查询隔离及无退役调用；`backend/tests/files.rs` 验证接口退役、单轮幂等、旧身份禁用、鉴权、容量和恢复。进程级账户与成功文件保留继续由 `files_process.rs` 覆盖。服务端仍在请求开始时鉴权，不因途中自然到期主动截断已认证请求。

隔离 Caddy HTTPS 长传输入口仍可用 `bash tests/caddy_ingress.sh` 复验；`FILEHOP_TEST_CHROME=1 bash tests/browser.sh` 可选用已安装的稳定版 Chrome。回环 Playwright、隔离存储和入口探针不代表真实 HTTPS、人工桌面 Chrome、生产更新或部署已通过。

数据库位于 `database/transfer.db`；两个根目录各有 `storage-id`，数据库也保存同一标识。使用 SQLite WAL + synchronous=FULL、事务、版本迁移与 Argon2id 随机盐哈希。初始化以目录排他锁协调并发，拒绝非空目录、重复/部分初始化及嵌套目录。普通检查不建库、不执行迁移；标识缺失、不匹配、数据库丢失或访问失败返回存储异常。

跨目录操作不是原子的。发生部分失败时保留残留并报告部分完成，**不要删除、覆盖或盲目重试**；先停止相关操作并人工核对两个目标目录。没有自动恢复或清库入口；密码重置只接受已初始化且存储标识一致的实例。目前状态检查是诊断，不代替后续业务写入在使用存储时的验证。

### 登录与会话（#7）

登录接口只接受配置的精确 HTTPS Origin 和 JSON，体积上限 8 KiB；用户名规则及密码规则与初始化一致。成功返回 `expires_at`、`server_time`（Unix 秒），设置 host-only `__Host-filehop` Cookie（Secure、HttpOnly、SameSite=Lax、Path=/、Max-Age=43200）。数据库只保存 SHA-256 凭证摘要及固定到期时间；读取不续期，重启不撤销。认证响应禁止缓存，应用 401 使用 `session_invalid` 或 `invalid_credentials` 区分；页面不会把外层错误或网络错误当作注销。登录结果未知先查询会话，只在确认未认证后允许再次登录。

`serve` 接受 `FILEHOP_ORIGIN` / `--origin` 及 `FILEHOP_TRUSTED_PROXY` / `--trusted-proxy`。Compose 从开发域名生成 Origin，并要求操作者填写 Caddy 在专用网络上的**精确、稳定 IP**。Caddy 示例覆盖 `X-FileHop-Client-IP` 为直接连接来源；后端只在 TCP 对端匹配该 IP 时读取该单地址头，其他对端只按 TCP 地址节流，忽略 XFF。不能填写整个网段或默认信任所有内网客户端；Caddy 地址变化须同步配置。额外 CDN/上游代理不在此默认信任链内，接入前另行核实。不配置代理时适用于直连回环测试，不是公网代理验收。

失败节流：每来源滚动 900 秒最多 10 次失败，在途验证预占次数；全局最多 2 次密码验证，无等待队列，过载返回 429 和 Retry-After。来源表最多 4096 项，满后拒绝新来源而不驱逐旧计数；失败计数可随重启清空。未知用户名执行相同 Argon2id 验证。后台验证任务持有并发槽直到结束，不因客户端断开提前释放。页面尊重登录 Retry-After；错误及节流不会记录密码或凭证。

Argon2id 使用 v0.6 默认参数 m=19456 KiB、t=2、p=1，双验证算法内存预算 38 MiB。部署时须在目标环境测量验证延迟和进程内存，并为 SQLite、运行时及其他业务保留资源；不要将某台开发机器的测量结果作为性能承诺。测量命令：

```bash
cargo test --release --manifest-path backend/Cargo.toml --test session_process measure_login_budget -- --ignored --nocapture
```

会话存储在首次发布前加入 `0001_next_release.sql`；该迁移现已冻结，后续结构变更使用新的递增编号文件。旧开发实例不会自动迁移；独立 `migrate` 也不会绕过旧 checksum，已有需保留的数据不得通过重新 init 处理。可丢弃开发实例也须由操作者明确授权并核对两个目录后再重建，本任务未清理任何既有实例。

验收映射：`backend/tests/session.rs` 覆盖固定时间、Origin/格式、节流/过载和凭证磁盘保护；`session_process.rs` 使用 SIGKILL 和正常退出后重启验证有效会话、固定到期时间、消息与发送标识保留及重放不重复（S001-A15 子进程部分）；Playwright 连接真实后端验证 Cookie、刷新恢复、外层 401、到期隐藏、迟到读取和登录响应丢失（S001-A08/A14 的当前切片）。文本草稿/消息相关验收见下方 #9；退出及撤销验证见下节。回环 localhost 的 Chromium 安全上下文不等于真实 HTTPS、稳定版 Chrome 或 Caddy 信任链验收，后者由 #13 完成。

### 退出与管理员撤销登录（#8）

`DELETE /api/session` 无请求体，仍严格检查精确 Origin，拒绝应用 Authorization。成功返回 `{ "state": "logged_out" }` 并清除安全 Cookie；重复退出、已到期或缺失凭证同样完成，仅删除当前请求携带的会话。存储不可用不报告撤销成功，不清除尚需用于重试的 Cookie；所有响应禁止缓存。

页面主动退出立即卸载受保护内容、清空当前登录输入并使迟到响应失效，通过 BroadcastChannel 通知同源已打开标签页保持清空。请求或响应丢失显示“退出未确认”，任意标签页可重试；确认完成或确认会话失效后同步进入登录界面。没有持久化退出锁，刷新/新页面仍可能识别到尚有效的 Cookie。已初始化页面不再提供会重新挂载会话组件的诊断刷新按钮，避免绕过内存退出状态；真正刷新页面仍遵循上述规则。独立浏览器会话不受当前退出影响，不宣称清除外层 Basic Auth。#9 已补齐未保存内容退出确认及草稿／发送清理；收到跨标签页通知时直接清空，不再逐页要求确认。

管理员确认目标实例后，在终端隐藏输入新密码（规则与初始化一致）：

```bash
docker compose --env-file .env -f deploy/compose.dev.yml exec backend \
  filehop --database-dir /data/database --files-dir /data/files reset-password
```

命令不接受密码参数，不执行初始化或迁移。新哈希和全部会话撤销在同一事务提交，不删除业务记录或服务器文件；失败不报告完成。旧密码验证若与重置并发，在创建会话的事务内重新核对所验证的哈希，避免重置后旧验证又创建有效登录。普通重启仍保留未过期会话。以上命令是说明，不代表已对任何现有实例执行重置。

验收映射（S001-A09/A14 当前切片）：`backend/tests/session.rs` 验证 Origin、幂等、缺失/到期凭证、独立会话及存储失败；`session_process.rs` 通过真实 PTY 验证隐藏输入、无效新密码不撤销、成功重置撤销多个会话、旧密码拒绝、新密码登录及合成文件/存储身份保留。`web/tests/logout.ts` 在现有真实后端浏览器流程中验证同源多标签页、独立上下文、请求/响应丢失、迟到读取、前台恢复和非持久化退出状态。#9 已通过真实 API 验证重置密码后消息与发送标识保留；Chromium 自动化不代替 #13 稳定版 Chrome 与真实 HTTPS 验收。

### 最小文本闭环（#9）

`POST /api/messages` 接受随机 UUID `send_id`、原样 `text` 和规范化 `source_label`，最多 512 KiB JSON；正文最多 65,536 UTF-8 字节，拒绝 Spec 固定空白集合组成的正文。来源标签以相同集合去除首尾空白后为 1–64 个 Unicode 码点。前后端使用 `tests/text-cases.json` 的共同验收样例。消息和发送标识在同一记录中原子持久化，提交成功后新建返回 201，同载荷重放 200，不同载荷返回 `409 send_conflict`；认证与 Origin 防护沿用会话边界。

最近页 `GET /api/messages?limit=50` 支持 1–100，返回 `{ messages, has_older, before, sync_cursor }`，消息按数值 ID 升序，ID 和游标是十进制字符串。最近页及快照最大 ID 来自同一个读事务，空快照游标为 `0`。现支持 `before=<正整数消息 ID>` 排他历史分页：从边界前取最近一页，仍以 ID 升序返回，`before` 为本页最小 ID，空页为 null；`has_older` 表示边界前是否还存在未返回记录。历史页不返回 `sync_cursor`，不改变新增读取基线。`after=<非负整数消息 ID>` 返回边界后最早一页及 `{ has_more, after }`；after 为本页最大 ID，空页为 null，不返回 sync_cursor。before/after 互斥，非法或未知参数返回结构化 `400 invalid_query`。发送结果查询见下节。

页面提供按钮和 Ctrl/Cmd+Enter 发送、输入法组合保护及手动刷新。消息按 ID 合并去重，本地发送和结果查询不推进同步游标；登录时读取最近快照建立基线，后续刷新逐页补齐新增，不跳过中间消息。文本用纯文本呈现，复制仅包含完整正文，权限失败有反馈。来源标签默认 Web，规范化后保存到浏览器 localStorage；正文及发送尝试只留在页面内存。

请求超时、断连、5xx、未知格式和冲突保留固定载荷并锁定发送；不会自动生成新标识或重发。已认证读取找到匹配标识、正文和标签的消息可确认成功。未知发送恢复操作见下节。首次发送遇到已知的输入／认证／Origin 前置拒绝才可保留正文并解锁；同次重试拒绝不证明原请求未保存，仍保留未知状态。

到期隐藏内容并保留内存草稿／未知发送，同页登录后恢复、读取历史但不自动发送；主动退出确认后与同源标签页一起清空，迟到响应失效。有未保存内容时尽力触发浏览器离开提醒，刷新不恢复草稿或自动重发。

验收证据：`backend/tests/messages.rs` 覆盖 S001-A03/A05、最近页快照、认证/Origin、真实 COMMIT 失败回滚、应用重建和密码重置后的消息/身份保留；`web/tests/messages.ts` 连接真实后端完成独立会话互发与复制、共享校验样例、组合输入、双击、响应丢失、读取确认、同页到期恢复、来源标签持久化、草稿不持久化、跨页退出和迟到发送保护（S001-A02–A06/A08/A09/A13/A17 的本票范围）。Chromium 不替代 #13 稳定版 Chrome、真实 HTTPS 或真实剪贴板权限人工验收；A06/A07 恢复动作及历史分页验证见下节；A11/A12 增量补齐、定时同步验证见下方前台同步说明。

消息表在首次发布前加入 `0001_next_release.sql`；该迁移现已冻结，不能继续改写。没有对既有实例执行迁移或清理；旧开发数据库不能用重新 init 处理，历史 checksum 不符且需保留的数据须另行处理结构兼容。

### 未知发送恢复

`GET /api/sends/{send_id}` 须重新认证，成功返回原始消息，所有结果禁止缓存；无效 UUID 返回 `422 invalid_send_id`，暂未找到返回结构化 `404 send_not_found`。未找到只表示查询时没有已提交记录，不取消在途请求，也不证明原发送不会提交。

页面结果未确认时提供查询、同次重试和放弃确认。查询与重试期间禁止重复恢复请求，允许明确放弃确认；同次重试保持原 UUID、正文和来源标签，跨同页重新登录亦不改变。重试收到输入、认证、Origin、节流或冲突错误仍保留未知状态；409 明示冲突，不自动换标识。历史读取匹配三项载荷即可直接确认，无需额外查询。

放弃前提示原消息可能已保存，保留可编辑草稿并提示再次发送可能重复，不撤回、不自动发送。再次主动发送使用新标识；放弃后迟到的成功响应只合并历史，不覆盖或清空新草稿。认证失效与主动退出仍使用既有代次隔离，旧恢复响应不能重新展示已隐藏或清除的内容。

`backend/tests/messages.rs` 覆盖真实 SQLite 的结果查询、缺失结果、认证及重放；`web/tests/send-recovery.ts` 在真实后端上验证提交后响应丢失、查询／重试找回、404 保持未知、同页重新登录后原身份重试、401/403/429/409 分类，以及放弃后的三条读取／发送入口乱序保护。结合既有 `web/tests/messages.ts` 的历史确认与退出测试覆盖 S001-A06–A09/A14 的本切片；增量读取确认与放弃保护由 `web/tests/sync.ts` 验证，稳定版 Chrome 和实际 HTTPS 仍需对应环境验收。

### 历史分页与阅读位置

页面首次读取最近 50 条并定位到底部，点击“加载更早消息”每次读取 50 条，不自动无限滚动。消息历史使用独立可滚动区域；插入旧页保留当前阅读位置，位于底部时跟随新增消息，否则提供“回到最新”。分页入口和提示预留布局空间，避免状态变化挤动阅读区域。

历史游标独立于快照、增量和本地发送；增量不覆盖已建立的旧页边界。读取失败保留已有消息和边界，允许再次点击重试；历史和增量读取互斥，但不阻止独立发送。所有结果沿用同一消息合并与发送确认入口，认证失效或退出后的旧请求不能更新当前页面。

验证入口：`backend/tests/messages.rs` 的真实 SQLite HTTP 分页用例覆盖排他边界、空页、limit、顺序、连续性及读取期间新增；`web/tests/history.ts` 通过现有浏览器编排验证连续加载、失败后同边界重试、位置保持、合并去重、历史读取确认未知发送、并发发送和退出后迟到响应（S001-A10、A11 合并部分及 A06/A09 相关约束）。人工验收仍需在稳定版 Chrome 中连续加载旧页、等待期间滚动、阅读旧消息时接收新增、回到底部后接收新增，确认视觉阅读位置符合预期；Chromium 自动化不替代该检查。

### 前台增量同步

页面可见时每 10 秒读取新增，隐藏后停止常规定时器；回到前台或点击读取按钮立即尝试。首次登录及同页重新登录重新建立最近 50 条和快照游标，后续用 after 顺序补齐全部新增，每页完整校验、合并后推进，空页不推进。历史分页和发送结果不改变增量进度。

网络或访问层失败保留消息和游标并提示，自动读取按 10、20、40、60 秒基准退避，加入向下最多 10% 的抖动以保证上限不超过 60 秒，成功恢复 10 秒。手动和前台恢复可提前尝试，但不得绕过 Retry-After（支持秒数或 HTTP 日期）；同一读取任务不重叠，历史读取也遵守当前读取冷却期。认证失效暂停业务请求，迟到结果不能恢复隐藏内容，不自动重发正文。

`backend/tests/messages.rs` 使用真实 SQLite 验证 after 排序、排他边界、连续多页及空页；`web/tests/sync.ts` 连接真实后端，覆盖多页中断续读、本地发送领先不漏消息、空页游标、前后台、退避、Retry-After、未知发送确认、放弃保护、阅读位置及到期/跨页退出后的迟到增量（S001-A06、A08–A12）。浏览器测试通过可控时间和网络拦截制造故障；稳定版 Chrome、真实 HTTPS 和人工视觉检查仍需对应环境验收。

## 桌面文本阶段复验入口

以下是长期复验导航，不代表某次执行已通过。实际命令结果、人工结论及未通过项记录在对应 Issue/PR/CI，不能用此表或既往入口验收替代当前提交的阶段验收。

| Spec 001 验收 | 自动化入口 | 仍需核实的边界 |
| --- | --- | --- |
| A01 | `initialization.rs`、`scaffold.rs`、浏览器初始化流程、`compose_smoke.sh` | 实际目标目录和初始化操作由操作者核对 |
| A02–A04 | `messages.rs`、`web/tests/messages.ts` | 稳定版 Chrome 双会话、系统剪贴板、真实输入法与快捷键 |
| A05 | `messages.rs` 并发与同标识重放 | 自动化不证明硬件故障恢复 |
| A06–A07 | `messages.rs`、`send-recovery.ts`、`sync.ts` | 人工确认未知结果提示、放弃确认与草稿保护可理解 |
| A08–A09 | `session.rs`、`session_process.rs`、`messages.rs`、浏览器会话/退出/恢复流程 | 稳定版 Chrome 到期与跨标签页视觉隐私；无需真实等待 12 小时 |
| A10–A12 | `messages.rs`、`history.ts`、`sync.ts` | 真实浏览器阅读位置、前后台切换与网络恢复 |
| A13 | `messages.ts` 来源标签及草稿生命周期 | 离开提醒受浏览器限制，需交互后人工检查 |
| A14 | `session.rs`、`messages.rs`、浏览器认证/恢复流程 | 当前实际代理信任链与公网入口 |
| A15 | `session_process.rs`、`compose_smoke.sh` | 不包含主机掉电或损坏磁盘恢复 |
| A16 | `caddy_ingress.sh` 隔离 TLS/页面/API/WSS、Compose 配置检查 | 真实域名证书、仅 443、内部端口不可公网直达和稳定版 Chrome；隔离证书不是公网证书证据 |
| A17 | 浏览器复制失败流程、初始化终端无回显、会话存储保护、`web_container_smoke.sh` 环境文件排除 | 真剪贴板权限、实际日志与拟公开内容隐私审阅 |

### 稳定版 Chrome 人工复验

先确认使用验收当时最新稳定版桌面 Chrome；具体版本、系统和必要截图保留在仓库外私有记录，公开仅写兼容类别、结果和非敏感证据引用。使用合成消息和专用测试账户，不在真实用户数据上注入故障。若当前站点不是待验收提交或无法安全隔离，记录阻塞；不要擅自部署、重置账户或改共享入口来完成清单。

1. 两个独立浏览器配置分别登录（不是两个共享 Cookie 的标签页），互发带缩进、换行、HTML/URL 字面量的合成文本，复制到本地文本编辑器比对完整正文；用真实输入法组合输入，核实 Enter、Ctrl/Cmd+Enter 和发送按钮（A02–A04）。
2. 在站点权限中拒绝剪贴板写入后尝试复制，期望明确失败提示而非“复制成功”；恢复权限再验证成功。浏览器若不提供对应开关，记录限制，不把模拟拒绝当成真权限通过（A17）。
3. 准备超过 50 条合成历史，连续加载更早消息，加载期间滚动；另一会话发送新消息时旧阅读位置保持，点击“回到最新”后跟随新增。隐藏再返回、短暂离线后恢复，核实提示、补齐和无重复（A10–A12）。
4. 输入草稿并先与页面交互，再刷新/关闭，检查浏览器尽力提供离开提醒；确认离开后不恢复或自动发送旧草稿。改来源标签后新消息使用新标签、旧消息不变（A13）。
5. 对照自动化恢复场景核实未知发送、放弃提示、同页重新登录及跨标签页退出后的内容隐藏；不可通过公开调试接口制造到期，不为人工验收新增生产故障钩子（A06–A09）。
6. 使用真实开发域名检查受信任证书，DevTools 中页面、API 和热更新仅走同域 HTTPS/WSS 443。全新浏览器配置未通过外层认证时页面/API/WSS 均被挡住；应用退出不宣称退出 Basic Auth。验证内部服务不可公网直达，不修改共享 Caddy 或网络规则。转发去除外层凭证由受控配置及隔离入口测试交叉证明，勿将凭证截图公开（A16）。
7. 仅审阅已授权的测试实例日志，确认没有正文、密码或 Cookie；审阅本次完整 Git diff、待公开日志/trace/截图及构建制品中的配置，排除真实数据和主机识别信息。不要为搜集证据读取或公开无关服务日志（A17）。

每项记录提交、操作、预期、结果及未验证部分；任一必要人工项待确认时，阶段保持未验收，不因自动化全绿关闭主 Issue。

## 安全与交付限制

- `.env`、`secrets/`、开发数据、数据库及本地 Caddy 配置由 Git 与 Docker 构建上下文排除；示例只含占位值。
- 前端不能包含运行密钥；不要把密码放入 `VITE_*` 环境变量。
- 当前不记录请求正文、密码或凭证；持久化实例标识、账户哈希、会话摘要/到期时间及已提交消息和发送标识。Compose 配置容器日志轮转。
- 当前容器配置为开发骨架，不是 Spec 004 生产产物或完整安全验收。
- 开发入口的真实 HTTPS/Basic Auth/WSS 及稳定版 Chrome 访问验证见 [Issue #13](https://github.com/nt1r/FileHop/issues/13)；后续业务路由变化仍需回归。本地 Chromium、隔离容器及静态配置检查不能代替完整人工验收。

## 官方参考

- [React：从零构建应用](https://react.dev/learn/build-a-react-app-from-scratch)
- [Vite：初始化](https://vite.dev/guide/) / [开发服务器配置](https://vite.dev/config/server-options)
- [Kumo：安装与 standalone 样式](https://kumo-ui.com/installation)
- [Cargo：cargo new](https://doc.rust-lang.org/cargo/commands/cargo-new.html)
- [Axum](https://docs.rs/axum/latest/axum/) / [SQLx](https://docs.rs/sqlx/latest/sqlx/)
- [Docker Compose](https://docs.docker.com/compose/) / [Caddy Basic Auth](https://caddyserver.com/docs/caddyfile/directives/basic_auth)
