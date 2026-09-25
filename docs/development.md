# FileHop 开发指南

本文面向贡献者，说明工程工具链、测试命令及隔离开发运行方式。所有命令均从仓库根目录执行；不是面向终端用户的生产安装指南。

产品介绍见[项目首页](../README.md)，需求见[产品基线](product.md)，实现顺序见[路线图](roadmap.md)。具体机器上的执行结果保留在[验证记录](verification-issue-6.md)，不作为其他环境已经可用的证明。

## 当前实现状态

当前开发切片支持隔离启动、显式初始化、安全登录恢复、退出及管理员撤销登录，以及文本发送／主动读取／复制、历史分页、未知发送恢复和前台增量同步闭环：

- `web/`：Vite + React + TypeScript + Kumo standalone 样式，初始化状态页面、安全登录、受保护的文本消息页、同页重新登录及同源标签页退出通知。
- `backend/`：Axum + Tokio + SQLx SQLite；显式 `init` / `reset-password` 管理命令、存储标识与账户迁移、`GET /api/status`、`POST /api/session`、`GET /api/session`、`DELETE /api/session`、`POST /api/messages`、最近页、before 历史分页及 after 增量分页 `GET /api/messages`、发送结果 `GET /api/sends/{send_id}`。
- `deploy/`：开发应用 Compose、容器构建文件及共享 Caddy 站点示例。
- `GET /internal/live` 仅返回 204，表示进程可响应；**不是数据库可用或业务就绪检查**。不通过公网入口开放。

状态查询仅返回 `uninitialized`、`initialized` 或 `storage_error`，禁止缓存且不泄露目录、账户或凭证。未初始化与存储异常不开放业务写入。文件、Android 及正式发布尚未实现；初始化成功不代表整个 Spec 001 已完成。GitHub 托管 CI 定义见 `.github/workflows/check.yml`，实际执行结果以对应提交的 Actions 检查为准。

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

后端冒烟验证未初始化容器重建不创建数据、Compose 内隐藏输入初始化，并在正常重启、SIGKILL 后启动及保留挂载重建后，通过实际容器的 HTTP API 验证消息、发送标识、有效登录和固定到期时间保留，同标识重放不重复。探测使用已构建 Web 镜像中的 Node，共享该测试容器的网络命名空间，不发布端口、不加入共享网络，也不向应用镜像安装工具。两个镜像均须从待验收提交构建，不能拿旧镜像的结果证明新提交。

测试容器使用调用者 UID/GID，数据库、文件目录和合成凭证仅在一次性目录内，结束后核对路径并清理；不代表生产部署、真实主机掉电、磁盘损坏恢复或文件持久化验收。

## 固定开发部署的管理入口

长期运行的开发站点应使用固定目录中的源码快照或专用普通 clone，不从可删除的 linked worktree 部署。`web/src` 是运行中的只读 bind mount，删除宿主源码会导致页面模块加载失败；数据库和文件目录也不能随 worktree 清理。固定目录仍需由操作者保留，脚本无法防止运行期间的外部删除。

仓库提供统一入口 `scripts/dev.sh`，由 Compose 协调前后端，不分别维护两个启动脚本。显式指定已准备好的绝对部署目录及入口类型：

```bash
# 路径为示例，替换成操作者确认的固定开发目录。
bash scripts/dev.sh /srv/filehop-dev host check
bash scripts/dev.sh /srv/filehop-dev host status
bash scripts/dev.sh /srv/filehop-dev host start
bash scripts/dev.sh /srv/filehop-dev host stop
```

从代码仓库调用脚本，参数指向固定部署目录；两者可以分离，无需向部署目录复制另一套管理脚本。选择与现有入口一致的模式：`host` 使用宿主 overlay，`container` 使用基础 Compose。项目名固定为 `filehop-dev`，每个 Docker daemon 仅管理这一套开发栈。

脚本只管理已有部署：启动使用已有镜像，停止保留容器和数据；构建、版本更新和账户初始化走下述独立流程。操作前核对同名项目所有容器（包括已停止容器）的部署目录、入口配置、服务及实际挂载；不匹配时拒绝操作，迁移必须另行确认。检查与操作之间仍需避免其他操作者并发修改该项目。路径检查细节以脚本为准。配置或目录损坏导致管理命令拒绝执行时，先核实项目归属再直接用 Docker 诊断，不能自动补建目录掩盖数据缺失。

执行前确认 Docker context 和 Shell 中的 Compose 配置变量指向目标开发实例；Shell 同名变量可覆盖 `.env`。`check` 通过只表示路径和 Compose 配置合法，服务健康和数据状态仍须复验。

### 初次准备与后续更新

1. **准备**：初次部署按[环境接入](#开发运行需先完成环境接入)落实网络、配置和目录权限；宿主入口另读[宿主入口指南](host-ingress.md)。更新已有实例时，先取得授权并核对现有挂载、数据和数据库结构兼容性。当前无独立升级命令，不兼容时停止更新，不能用 `init` 或清库替代。
2. **构建**：在维护窗口停止已有服务，仅替换受版本管理的源码，保留 `.env`、`data-dev/` 和本地运行记录；避免全目录删除或清理。完成条件是两个镜像均由目标源码构建，而非仅存在同名镜像。可用本地 `DEPLOYED_COMMIT` 记录 SHA，记录本身不证明镜像版本。
3. **复验**：启动后验证页面入口模块、API、外层认证及预期数据状态，再完成浏览器复验。已有实例变为未初始化时停止验收并调查数据，不创建替代账户。

脚本和测试纳入版本管理；实际配置、凭证、数据库、文件和 `DEPLOYED_COMMIT` 留在部署目录，不提交。

本地验证：`bash tests/dev_script.sh` 检查公开 CLI 拒绝路径及 Docker 调用参数（使用假 Docker，不接触运行栈）；真实 Compose 配置和容器能力由既有配置检查与隔离冒烟验证，不把 CLI 测试当作容器启动证据。

## GitHub Actions 检查分层

`.github/workflows/check.yml` 保留单个 `initialization` job，在 GitHub 托管 runner 上按事件选择检查范围：

| 事件 | 基础检查 | 镜像构建与容器冒烟 |
| --- | --- | --- |
| 普通 PR → dev | 运行 | 默认跳过；下述风险路径变化时运行 |
| dev → main 发布 PR | 运行 | 始终运行 |
| push → dev/main（包括合并后） | 运行 | 跳过 |
| Actions 手动运行（workflow_dispatch） | 运行 | 始终运行 |

基础检查包含 Rust fmt/Clippy/测试/构建、Web lint/TypeScript/构建、真实后端浏览器冒烟、隔离 HTTPS 入口测试、Shell 语法和 Compose 配置校验，不因普通业务代码所属目录而省略。

开发 PR 使用 base/head 的 merge-base 差异检查整个 PR，而非仅最后一次提交；关闭重命名检测以同时覆盖旧路径删除和新路径添加。以下变化会增加完整容器检查：`deploy/`、`scripts/`、`.github/`、`tests/`、Docker 忽略规则及示例环境文件、Node/Rust 工具链、Cargo manifest/锁文件/配置/build.rs/迁移、前端包管理 manifest/锁文件/配置/补丁，以及 Web 构建配置与 HTML 入口。精确路径以 workflow 的 `case` 规则为准；新增构建输入时同步维护规则。

普通业务变化也可能产生容器特有问题；默认延迟到发布 PR 检查。有相关风险时，在 Actions 的 Application checks 中选择对应分支手动运行完整检查（手动入口需先存在于默认分支），不要把基础检查成功当作容器路径已验证。并发组按 workflow、事件类型和 ref 隔离，手动完整检查不会被同分支的 push 基础检查取消；同一事件类型与 ref 的新运行仍会取消旧运行。

当前镜像仅加载到 runner 用于测试，不推送 GHCR、不部署；Web 镜像运行开发 Vite，不是生产静态制品。正式版本 tag 的 ARM64 构建与发布遵循 Spec 004，尚未实现。PR 来源策略仍由独立的 `.github/workflows/pr-policy.yml` 检查。

## GitHub Actions 缓存

`.github/workflows/check.yml` 在所选检查范围内复用以下缓存；缓存命中不代替相应安装、构建或测试：

- pnpm：Corepack 启用固定版本后，在 `web/` 中查询实际 store 路径，通过 `actions/cache` 保存下载内容，不缓存 `node_modules`。键区分 OS、架构、Node/包管理器配置和锁文件；锁文件变化时可恢复兼容的旧下载内容，再由 `--frozen-lockfile` 补齐。
- Cargo：`Swatinem/rust-cache` 缓存下载与 `backend/target` 中的依赖编译产物，不缓存工具安装目录。键区分 runner OS/架构，并由 Action 纳入实际 Rust 编译器、相关环境变量、工具链文件、Cargo manifest 和锁文件。
- Docker：Buildx 使用 GitHub Actions v2 缓存后端，前后端按 OS/架构使用独立 `checks-*` scope，`mode=max` 包含中间构建层；工具链镜像、锁文件与源码变化由 BuildKit 层摘要判断。镜像不推送仓库，通过 `load: true` 加载到本次 runner，继续运行现有容器冒烟。

这些缓存仅用于检查，不作为发布制品或未来特权发布的可信输入。GitHub 将 PR 写入的缓存限制在该 PR 的 merge ref，PR 可读取可见的基分支缓存，不能将其写回基分支。未来发布流程须使用独立缓存命名空间与可信准入，不能直接复用检查缓存。缓存内容不得包含凭证、数据库或真实用户文件。

dev/main 的 push 基础检查不构建镜像，因此不会刷新对应分支的 Docker 缓存；PR 写入的缓存也不会自动成为后续其他 PR 可复用的基分支缓存。依赖、工具链或基础镜像有较大更新后，如需改善后续 PR 的容器构建耗时，可在合入 dev 后选择 dev 手动运行一次完整检查，刷新其 Docker 缓存。这是可选的性能维护，不是正确性门槛；不为预热缓存恢复每次 push 的镜像构建。

首次运行、依赖/工具链更新或缓存被淘汰后仍可能下载；缓存命中也仍执行安装与正确性检查。宿主 Cargo/pnpm 缓存与 Docker 构建缓存互不共享。后端 Dockerfile 目前源码改变会使 release 编译层失效，目前仅使用跨运行层缓存，尚未引入依赖预编译分层。Playwright 浏览器和 Linux 系统依赖暂不缓存。

验证冷/热缓存时，选择会触发容器检查的 PR 首次运行与再次运行，或对同一提交手动运行两次完整检查：两次完整检查都应通过；第二次 pnpm/Cargo 步骤应报告缓存恢复，Docker 应出现缓存导入及适用层的 `CACHED`，且两个容器冒烟仍执行。需要强制冷缓存时，在临时测试分支更换缓存键前缀和 Docker scope，不删除共享缓存。实际命中率与耗时以对应运行日志为准，本地静态校验不能代替此验证。

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

使用独立宿主入口时，按[宿主入口指南](host-ingress.md)配置 Compose overlay 和独立服务，不直接套用容器 Caddy 网络示例。开发入口验收证据见 [Issue #13](https://github.com/nt1r/FileHop/issues/13)。

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

单文件后端配置：`FILEHOP_MAX_FILE_BYTES` 默认 104857600、`FILEHOP_FILE_QUOTA_BYTES` 默认 1073741824；`FILEHOP_TRANSFER_ACTIVE_LIMIT` 默认 8（分别限制同时上传、下载和准备请求）；`FILEHOP_DISK_RESERVE_BYTES` 默认 67108864。未开始的准备与最近一小时的申请记录合计最多 64 项（也覆盖零字节申请），满额或准入竞争时返回 429，不排无限等待队列。准备请求体最多 8 KiB、读取期限 15 秒；`FILEHOP_PREPARE_TIMEOUT_SECS` 默认 120，`FILEHOP_UPLOAD_IDLE_SECS` 默认 120，`FILEHOP_UPLOAD_TOTAL_SECS` 默认 1800，`FILEHOP_DOWNLOAD_IDLE_SECS` 默认 120。下载每条活动流最多缓存两个 64 KiB 块；后台清理默认每 5 秒协调最多 64 项，失败退避至 60 秒。这些参数以小型 VPS 上有限并发、保留 64 MiB 磁盘余量为起点，不代替目标机器的实际空间及内存验证；本票未提供桌面上传入口；浏览器自动化仅验证文件消息与附件下载。隔离 Caddy HTTPS 入口已验证持续 16 秒的分块请求（`bash tests/caddy_ingress.sh`），后端也验证了超过 15 秒的上传；后续桌面上传客户端仍须单独配置文件体期限与进度。可用 `FILEHOP_TEST_CHROME=1 bash tests/browser.sh` 在安装了稳定版 Chrome 的机器上验证真实浏览器下载（默认运行 Playwright Chromium）；本地回环及自签名隔离入口不代替正式环境验收。文件表与消息类型现合入尚未进入 `main` 的 `0001_next_release.sql`，从全新实例初始化并测试，不宣称提供从旧 `0001` 的升级路径。若开发实例已应用旧版 `0001`，其 checksum 已改变；普通 `serve` 不会升级它，也不得自动清理或重写 checksum。只有操作者确认实例可丢弃并核对数据库和文件目录后才能显式重建；需保留数据的实例须等待独立升级入口，不能用 `init` 代替。

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

本轮在尚未进入 `origin/main` 的 `0001_next_release.sql` 增加消息表。没有对既有实例执行迁移或清理；旧开发数据库不能用重新 init 处理，需保留的数据等待独立升级路径。

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
