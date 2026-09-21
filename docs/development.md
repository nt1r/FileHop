# FileHop 开发指南

本文面向贡献者，说明工程工具链、测试命令及隔离开发运行方式。所有命令均从仓库根目录执行；不是面向终端用户的生产安装指南。

产品介绍见[项目首页](../README.md)，需求见[产品基线](product.md)，实现顺序见[路线图](roadmap.md)。具体机器上的执行结果保留在[验证记录](verification-issue-6.md)，不作为其他环境已经可用的证明。

## 当前实现状态

当前开发切片支持隔离启动与显式初始化：

- `web/`：Vite + React + TypeScript + Kumo standalone 样式，初始化状态页面与手动刷新。
- `backend/`：Axum + Tokio + SQLx SQLite；显式 `init` 管理命令、存储标识与账户迁移、`GET /api/status`。
- `deploy/`：开发应用 Compose、容器构建文件及共享 Caddy 站点示例。
- `GET /internal/live` 仅返回 204，表示进程可响应；**不是数据库可用或业务就绪检查**。不通过公网入口开放。

状态查询仅返回 `uninitialized`、`initialized` 或 `storage_error`，禁止缓存且不泄露目录、账户或凭证。未初始化与存储异常不开放业务写入。认证、消息、文件、Android 及正式发布尚未实现；初始化成功不代表整个 Spec 001 已完成。GitHub 托管 CI 定义见 `.github/workflows/check.yml`，实际执行结果以对应提交的 Actions 检查为准。

## 工具链与本地检查

测试使用 Rust / Playwright / Bash，见[测试规范](testing.md)，不需要 Python。Bash 在 Linux 宿主机或 CI runner 上编排，需具备 Node、Cargo、Docker、curl 及标准 GNU 工具；不要求应用镜像提供这些宿主工具。

- Node `24.21.0`（`.nvmrc`），npm `11.19.0`。
- Rust `1.98.1`，rustfmt / Clippy（`rust-toolchain.toml`）；安装后确认 `cargo`、`rustc` 可在开发终端调用。
- Docker Engine 与支持当前配置的 Compose v2+。
- 提交 `web/package-lock.json` 和 `backend/Cargo.lock`；安装和构建遵循锁文件。

从仓库根目录执行，不需要数据库、账户或公网端口：

```bash
npm --prefix web ci
npm --prefix web run lint
npm --prefix web run build
cargo fmt --manifest-path backend/Cargo.toml --check
cargo clippy --manifest-path backend/Cargo.toml --locked --all-targets -- -D warnings
cargo test --manifest-path backend/Cargo.toml --locked
cargo build --manifest-path backend/Cargo.toml --locked
(cd web && npx playwright install chromium)
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

跨目录操作不是原子的。发生部分失败时保留残留并报告部分完成，**不要删除、覆盖或盲目重试**；先停止相关操作并人工核对两个目标目录。没有自动恢复、清库或密码重置入口（重置属于 #8）。目前状态检查是诊断，不代替后续业务写入在使用存储时的验证。

Argon2id 当前采用依赖默认参数（v0.6：m=19456 KiB、t=2、p=1），初始化一次约需 19 MiB 算法内存。登录并发预算与生产性能测量属于 #7，不能将初始化耗时当作登录容量保证。

## 安全与交付限制

- `.env`、`secrets/`、开发数据、数据库及本地 Caddy 配置由 Git 与 Docker 构建上下文排除；示例只含占位值。
- 前端不能包含运行密钥；不要把密码放入 `VITE_*` 环境变量。
- 当前不记录请求正文、密码或凭证；仅持久化实例标识与账户哈希。Compose 配置容器日志轮转。
- 当前容器配置为开发骨架，不是 Spec 004 生产产物或完整安全验收。
- 真实稳定版 Chrome、HTTPS/Basic Auth/WSS 由 #13 验证；本地 Chromium、隔离容器及静态配置检查不能代替这些验证。

## 官方参考

- [React：从零构建应用](https://react.dev/learn/build-a-react-app-from-scratch)
- [Vite：初始化](https://vite.dev/guide/) / [开发服务器配置](https://vite.dev/config/server-options)
- [Kumo：安装与 standalone 样式](https://kumo-ui.com/installation)
- [Cargo：cargo new](https://doc.rust-lang.org/cargo/commands/cargo-new.html)
- [Axum](https://docs.rs/axum/latest/axum/) / [SQLx](https://docs.rs/sqlx/latest/sqlx/)
- [Docker Compose](https://docs.docker.com/compose/) / [Caddy Basic Auth](https://caddyserver.com/docs/caddyfile/directives/basic_auth)
