# FileHop 开发指南

本文面向贡献者，说明工程工具链、测试命令及隔离开发运行方式。所有命令均从仓库根目录执行；不是面向终端用户的生产安装指南。

产品介绍见[项目首页](../README.md)，需求见[产品基线](product.md)，实现顺序见[路线图](roadmap.md)。具体机器上的执行结果保留在[验证记录](verification-issue-6.md)，不作为其他环境已经可用的证明。

## 当前实现状态

当前开发切片支持隔离启动、显式初始化、安全登录恢复、退出及管理员撤销登录，以及最小文本发送／主动读取／复制闭环：

- `web/`：Vite + React + TypeScript + Kumo standalone 样式，初始化状态页面、安全登录、受保护的文本消息页、同页重新登录及同源标签页退出通知。
- `backend/`：Axum + Tokio + SQLx SQLite；显式 `init` / `reset-password` 管理命令、存储标识与账户迁移、`GET /api/status`、`POST /api/session`、`GET /api/session`、`DELETE /api/session`、`POST /api/messages`、最近页 `GET /api/messages`。
- `deploy/`：开发应用 Compose、容器构建文件及共享 Caddy 站点示例。
- `GET /internal/live` 仅返回 204，表示进程可响应；**不是数据库可用或业务就绪检查**。不通过公网入口开放。

状态查询仅返回 `uninitialized`、`initialized` 或 `storage_error`，禁止缓存且不泄露目录、账户或凭证。未初始化与存储异常不开放业务写入。完整历史分页、定时增量同步、未知发送恢复操作入口、文件、Android 及正式发布尚未实现；初始化成功不代表整个 Spec 001 已完成。GitHub 托管 CI 定义见 `.github/workflows/check.yml`，实际执行结果以对应提交的 Actions 检查为准。

## 工具链与本地检查

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

前端冒烟验证根目录及嵌套 `.env*` 文件不进入构建上下文，并以非 root 用户、实际开发只读挂载启动 Vite，检查 HTML 与源码转换响应；不发布端口。

后端冒烟验证未初始化容器重建不创建数据、Compose 内隐藏输入初始化及重建后挂载数据可被状态 interface 验证。测试容器使用调用者 UID/GID，数据仅在一次性目录内；不代表生产部署或后续消息/文件持久化验收。

## GitHub Actions 缓存

`.github/workflows/check.yml` 在 GitHub 托管 runner 上复用以下缓存，不跳过原有安装、构建或测试：

- pnpm：Corepack 启用固定版本后，在 `web/` 中查询实际 store 路径，通过 `actions/cache` 保存下载内容，不缓存 `node_modules`。键区分 OS、架构、Node/包管理器配置和锁文件；锁文件变化时可恢复兼容的旧下载内容，再由 `--frozen-lockfile` 补齐。
- Cargo：`Swatinem/rust-cache` 缓存下载与 `backend/target` 中的依赖编译产物，不缓存工具安装目录。键区分 runner OS/架构，并由 Action 纳入实际 Rust 编译器、相关环境变量、工具链文件、Cargo manifest 和锁文件。
- Docker：Buildx 使用 GitHub Actions v2 缓存后端，前后端按 OS/架构使用独立 `checks-*` scope，`mode=max` 包含中间构建层；工具链镜像、锁文件与源码变化由 BuildKit 层摘要判断。镜像不推送仓库，通过 `load: true` 加载到本次 runner，继续运行现有容器冒烟。

这些缓存仅用于检查，不作为发布制品或未来特权发布的可信输入。GitHub 将 PR 写入的缓存限制在该 PR 的 merge ref，PR 可读取可见的基分支缓存，不能将其写回基分支。未来发布流程须使用独立缓存命名空间与可信准入，不能直接复用检查缓存。缓存内容不得包含凭证、数据库或真实用户文件。

首次运行、依赖/工具链更新或缓存被淘汰后仍可能下载；缓存命中也仍执行安装与正确性检查。宿主 Cargo/pnpm 缓存与 Docker 构建缓存互不共享。后端 Dockerfile 目前源码改变会使 release 编译层失效，本次只增加跨运行层缓存，不引入依赖预编译分层。Playwright 浏览器和 Linux 系统依赖暂不缓存。

验证冷/热缓存时，在 GitHub 上观察同一 PR 的首次运行与再次运行：两次完整检查都应通过；第二次 pnpm/Cargo 步骤应报告缓存恢复，Docker 应出现缓存导入及适用层的 `CACHED`，且两个容器冒烟仍执行。需要强制冷缓存时，在临时测试分支更换缓存键前缀和 Docker scope，不删除共享缓存。实际命中率与耗时以对应运行日志为准，本地静态校验不能代替此验证。

## 开发运行：需先完成环境接入

开发者连接 VPS；浏览器仅使用开发域名的 HTTPS/WSS 443。不要直接在 VPS 执行 `cargo run` 或将 Vite 端口映射到公网。本工程不自动接入现有 Caddy、不自动创建网络、不修改防火墙，也不启动第二个入口抢占 443。

1. 将 `.env.example` 复制为 `.env`，填写完整开发域名及**专用开发网络**名称。示例 `.invalid` 域名不能用于真实接入。
2. 经操作者确认后，为开发栈建立网络并让共享 Caddy 加入。生产与开发不得共用应用网络；开发代理别名为 `filehop-dev-backend` / `filehop-dev-web`，应用内后端仍为 `backend:8080`。
3. 确认仓库所在绝对路径后，建立 `data-dev/database`、`data-dev/files`。后端容器以 UID/GID `10001` 运行，显式初始化需要这两个目录可写；由操作者设置目录权限，不使用 `chmod 777`。Compose 拒绝自动创建缺失的挂载目录。
4. 审阅 `deploy/Caddyfile.dev.example` 并整合至共享入口。开发域名、独立 Basic Auth 用户及密码哈希由 Caddy 的受控本地配置提供；应用 `.env` 不会自动传给共享 Caddy。真实密码与哈希均不提交 Git。Caddy 转发前移除外层 Authorization；外层错误带 `X-FileHop-Access-Layer: development`，客户端后续不得将其误认为应用会话失效。
5. 共享入口全局配置须关闭自动 HTTP 跳转（`auto_https disable_redirects`），仅发布 TCP 443，使用 TLS-ALPN-01；示例禁用 HTTP-01。修改共享全局配置会影响其他站点，须单独审阅授权。确认 DNS/CAA、OCI 规则和实际可达性，不能通过忽略证书检查验收。
6. 配置校验及授权完成后，才在根目录执行：

   ```bash
   docker compose --env-file .env -f deploy/compose.dev.yml config --quiet
   docker compose --env-file .env -f deploy/compose.dev.yml up --build -d
   ```

浏览器访问 `https://<开发域名>`，先通过开发外层认证。HMR 经同域 WSS 443，源文件只读挂载供热更新；依赖变更需重新构建。Compose 不发布前后端端口，Caddy 不挂载数据库或文件目录。

使用独立宿主入口时，按[宿主入口指南](host-ingress.md)配置 Compose overlay 和独立服务，不直接套用容器 Caddy 网络示例。开发入口验证结论见 [#13 记录](verification-issue-13.md)。

**以上是操作说明，不代表网络、域名、Caddy 或真实账户已经配置。** 普通运行不会创建数据库或账户，不能用 `sqlx database create` 代替显式初始化。

迁移编号、`main` 冻结、checksum、开发数据与发布关联规则见[数据库迁移维护规则](../backend/migrations/README.md)。已有实例的独立升级命令尚未实现，不能用 `init` 代替升级。

### 显式初始化

确认开发数据目标目录全新、可写且彼此独立，然后执行（命令显示目标路径，密码通过终端隐藏输入，不接受密码参数）：

```bash
docker compose --env-file .env -f deploy/compose.dev.yml exec backend \
  filehop --database-dir /data/database --files-dir /data/files \
  init --username your_admin --confirm-paths
```

`--confirm-paths` 表示操作者已确认上述两个路径；不代表允许覆盖。用户名为 3–32 个 ASCII 字母、数字、`_`、`-`，保存时转小写；密码为 12–128 个 Unicode 码点，不 trim。初始化成功后在页面点击“刷新状态”，无需重启后端。

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

本轮整理尚未进入 main 的 `0001_next_release.sql`，加入会话存储。旧开发实例不会自动迁移；当前无升级命令，已有需保留的数据不得通过重新 init 处理。可丢弃开发实例也须由操作者明确授权并核对两个目录后再重建，本任务未清理任何既有实例。

验收映射：`backend/tests/session.rs` 覆盖固定时间、Origin/格式、节流/过载和凭证磁盘保护；`session_process.rs` 使用 SIGKILL 后重启验证有效会话保留（S001-A15 会话部分）；Playwright 连接真实后端验证 Cookie、刷新恢复、外层 401、到期隐藏、迟到读取和登录响应丢失（S001-A08/A14 的当前切片）。文本草稿/消息相关验收见下方 #9；退出及撤销验证见下节。回环 localhost 的 Chromium 安全上下文不等于真实 HTTPS、稳定版 Chrome 或 Caddy 信任链验收，后者由 #13 完成。

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

最近页 `GET /api/messages?limit=50` 支持 1–100，返回 `{ messages, has_older, before, sync_cursor }`，消息按数值 ID 升序，ID 和游标是十进制字符串。最近页及快照最大 ID 来自同一个读事务，空快照游标为 `0`。本票尚不提供 `before`/`after` 查询和发送结果查询入口，传入未支持查询参数返回结构化 `400 invalid_query`，不静默当成最近页。完整分页、增量补齐与恢复操作由后续票交付。

页面提供按钮和 Ctrl/Cmd+Enter 发送、输入法组合保护及主动读取最近消息；不定时同步。消息按 ID 合并去重，本地发送不推进同步游标；重新读取最近页可建立新的快照基线，不承诺补齐超过一页的中间消息。文本用纯文本呈现，复制仅包含完整正文，权限失败有反馈。来源标签默认 Web，规范化后保存到浏览器 localStorage；正文及发送尝试只留在页面内存。

请求超时、断连、5xx、未知格式和冲突保留固定载荷并锁定发送；不会自动生成新标识或重发。已认证读取找到匹配标识、正文和标签的消息可确认成功。恢复操作入口尚未交付，读不到的未知发送会继续锁定。首次发送遇到已知的输入／认证／Origin 前置拒绝才可保留正文并解锁；将来增加同次重试时不能把重试拒绝当成原请求未保存。

到期隐藏内容并保留内存草稿／未知发送，同页登录后恢复、读取历史但不自动发送；主动退出确认后与同源标签页一起清空，迟到响应失效。有未保存内容时尽力触发浏览器离开提醒，刷新不恢复草稿或自动重发。

验收证据：`backend/tests/messages.rs` 覆盖 S001-A03/A05、最近页快照、认证/Origin、真实 COMMIT 失败回滚、应用重建和密码重置后的消息/身份保留；`web/tests/messages.ts` 连接真实后端完成独立会话互发与复制、共享校验样例、组合输入、双击、响应丢失、读取确认、同页到期恢复、来源标签持久化、草稿不持久化、跨页退出和迟到发送保护（S001-A02–A06/A08/A09/A13/A17 的本票范围）。Chromium 不替代 #13 稳定版 Chrome、真实 HTTPS 或真实剪贴板权限人工验收；未提供完整 A06/A07 恢复动作与 A10–A12 分页/同步证据。

本轮在尚未进入 `origin/main` 的 `0001_next_release.sql` 增加消息表。没有对既有实例执行迁移或清理；旧开发数据库不能用重新 init 处理，需保留的数据等待独立升级路径。

## 安全与交付限制

- `.env`、`secrets/`、开发数据、数据库及本地 Caddy 配置由 Git 与 Docker 构建上下文排除；示例只含占位值。
- 前端不能包含运行密钥；不要把密码放入 `VITE_*` 环境变量。
- 当前不记录请求正文、密码或凭证；持久化实例标识、账户哈希、会话摘要/到期时间及已提交消息和发送标识。Compose 配置容器日志轮转。
- 当前容器配置为开发骨架，不是 Spec 004 生产产物或完整安全验收。
- 真实稳定版 Chrome、HTTPS/Basic Auth/WSS 由 #13 跟踪；已完成部分真实域名验证，见[核查记录](verification-issue-13.md)。本地 Chromium、隔离容器及静态配置检查不能代替完整人工验收。

## 官方参考

- [React：从零构建应用](https://react.dev/learn/build-a-react-app-from-scratch)
- [Vite：初始化](https://vite.dev/guide/) / [开发服务器配置](https://vite.dev/config/server-options)
- [Kumo：安装与 standalone 样式](https://kumo-ui.com/installation)
- [Cargo：cargo new](https://doc.rust-lang.org/cargo/commands/cargo-new.html)
- [Axum](https://docs.rs/axum/latest/axum/) / [SQLx](https://docs.rs/sqlx/latest/sqlx/)
- [Docker Compose](https://docs.docker.com/compose/) / [Caddy Basic Auth](https://caddyserver.com/docs/caddyfile/directives/basic_auth)
