# FileHop 开发指南

面向贡献者，说明本地检查、隔离开发环境和开发部署。命令均从仓库根目录执行。正式安装与更新见[生产指南](production.md)，产品契约见[路线图中的 Specs](roadmap.md)。

## 准备工具链

- Node 版本以 [`.nvmrc`](../.nvmrc) 为准，pnpm 由 [`web/package.json`](../web/package.json) 的 `packageManager` 固定；用 Corepack 启用 pnpm。
- Rust 及 rustfmt／Clippy 以 [`rust-toolchain.toml`](../rust-toolchain.toml) 为准。
- 开发栈使用 Docker Engine 和 Compose v2；测试编排使用 Linux、Bash、curl 及 GNU 工具。权限测试须以非 root 用户运行。
- Android 的官方 SDK 构建、签名及安装见 [Android 指南](android.md)。

```bash
corepack enable pnpm
pnpm -C web install --frozen-lockfile
```

每个 worktree 使用独立的 `node_modules`，包文件由 pnpm store 复用；可用 `pnpm -C web store path` 核对实际位置。依赖安装脚本按需审阅和批准，不无条件放行。

### 工具链维护约定

- 有 LTS 支持线的运行时和 CI 操作系统优先使用兼容的受支持 LTS；GitHub runner 固定 Ubuntu LTS 系列，不使用 `ubuntu-latest`。其余工具使用兼容的正式稳定版，安全补丁及时评估。升级须显式修改配置并验证，不自动追随最新大版本。
- 检查与发布使用一致的核心工具链。同名 Actions 固定相同的完整 commit SHA，旁注 release tag；下载的 SDK、Gradle、Caddy 归档校验摘要，应用提交锁文件。
- runner 预装工具、未固定 digest 的基础镜像等仍可能浮动；不把锁文件或缓存命中当作完整可复现构建的证明。Java 发行版及补丁选择限制见 [Android 工具链](android.md#工具链与构建)。

## 本地检查

以下检查不需要真实账户、生产数据库或公网端口。浏览器编排创建一次性后端与存储，使用合成数据；`browser.sh` 读取已有 `web/dist`，先构建再运行。

```bash
pnpm -C web run lint
pnpm -C web run build
cargo fmt --manifest-path backend/Cargo.toml --check
cargo clippy --manifest-path backend/Cargo.toml --locked --all-targets -- -D warnings
cargo test --manifest-path backend/Cargo.toml --locked
cargo build --manifest-path backend/Cargo.toml --locked
pnpm -C web exec playwright install chromium
bash tests/browser.sh
```

可给浏览器脚本传入相关 spec，例如：

```bash
bash tests/browser.sh web/tests/server-files.spec.ts
```

检查力度与完成判定以[测试原则](testing.md)为准。涉及资源、容器、代理、迁移或真实浏览器交互时，按[验证指南](verification.md)选择补充检查；不要把命令列表当作每次修改的全套验收要求。

## 开发环境接入

开发入口只通过独立域名的 HTTPS/WSS 443 访问，前后端不发布公网端口。开发和生产的账户、配置、数据及应用网络隔离。网络、共享入口和持久数据操作须先取得授权，保留既有远程管理入口。

首次接入按以下顺序进行；已有需保留的实例走迁移，不重新初始化：

1. **准备配置和目录**：参考 [`.env.example`](../.env.example) 创建仓库外或已忽略的实际配置。填写开发域名、专用网络和精确的可信代理 IP；示例 `.invalid` 域名及文档 IP 不能用于真实接入。确认 `data-dev/database`、`data-dev/files` 彼此独立、已存在且可由容器 UID/GID 10001 写入，不使用 `chmod 777`。
2. **配置入口**：经授权建立专用应用网络；容器 Caddy 加入该网络，宿主 Caddy 使用该网络的固定内部地址。容器入口参考 [`deploy/Caddyfile.dev.example`](../deploy/Caddyfile.dev.example)；宿主入口按[独立宿主开发入口](host-ingress.md)配置服务和 Compose overlay。落实开发 Basic Auth、同域 WSS、仅 TCP 443 及证书持久化。全局关闭 HTTP 跳转并使用 TLS-ALPN-01 而非 HTTP-01，核实 DNS／CAA 和云入站规则。共享全局 Caddy 配置变更需单独审阅授权。
3. **核对代理信任**：可信代理必须是实际受控 Caddy 的精确、稳定地址，不是整个网段。Caddy 覆盖客户端来源头并移除外层 Authorization；额外 CDN 或上游代理需另行核实。Caddy 地址变化时同步后端配置。
4. **校验并启动**：确认配置、路径和网络后，使用与入口相符的一组 Compose 文件启动。以下为容器入口示例；`.env` 替换为实际配置文件，宿主方案需同时传入 `deploy/compose.host.yml`。

   ```bash
   docker compose --env-file .env -f deploy/compose.dev.yml config --quiet
   docker compose --env-file .env -f deploy/compose.dev.yml up --build -d
   ```

5. **初始化并检查**：按下节初始化全新实例。浏览器通过开发外层认证后访问页面，验证 HTTPS、API 和 HMR 均使用同域 443；业务登录不能代替开发服务器的外层访问保护。

Caddy 的环境文件独立于应用 `.env`；后者不会自动传给共享入口。真实密码、哈希、证书及日志留在仓库外，前端 `VITE_*` 变量不能承载运行密钥。Compose 源文件只读挂载供热更新，依赖变更须重新构建。

### 显式初始化

确认数据库及文件目录全新、可写且不嵌套，在终端执行：

```bash
docker compose --env-file .env -f deploy/compose.dev.yml exec backend \
  filehop --database-dir /data/database --files-dir /data/files \
  init --username your_admin --confirm-paths
```

使用宿主 overlay 时，沿用启动时的同一组 Compose 参数。密码通过隐藏输入读取，不放入参数、环境变量或日志；账户校验规则见 [Spec 001](specs/001-desktop-text-loop.md#凭证规则)。`--confirm-paths` 表示已核对目标，不允许覆盖已有实例。

成功后页面可刷新初始化状态，无需重启后端。普通启动不建替代库、不升级结构；已有或部分初始化目录被拒绝时，保留残留并人工核对，不清空重试。重置密码使用同一实例的 `filehop reset-password`，会撤销全部登录但不删除消息和文件。

## 固定开发部署

长期开发站点使用固定源码目录，不从可删除的 linked worktree 部署：源文件正被容器挂载，删除目录会使站点失效。配置、数据和部署记录同样保存在固定位置。

[`scripts/dev.sh`](../scripts/dev.sh) 从当前仓库同步到已配置的开发实例，每个 Docker daemon 管理一套固定为 `filehop-dev` 的项目；新目录及入口配置须先由操作者准备。执行前核对 Docker context、实际挂载和 shell 中的 Compose 配置变量，保存草稿并结束传输。

```bash
# 默认识别已有开发实例，完整部署当前源码（含未提交修改）。
bash scripts/dev.sh
# 查询或控制已部署版本，不更新源码。
bash scripts/dev.sh status
bash scripts/dev.sh start
bash scripts/dev.sh stop
# 仅同步兼容的 Web 输入。
bash scripts/dev.sh sync
# 无法自动识别时，显式提供固定目录和入口类型。
bash scripts/dev.sh /srv/filehop-dev host check
```

- 默认动作 `deploy`：先构建，再停旧服务，用目标镜像及原挂载迁移，成功后同步应用输入并启动。保留实际配置和数据；不修改 Caddy 或网络。
- `sync`：只同步 Web 源码、入口和 Vite 配置，复用已有镜像；不迁移数据。后端、依赖、迁移或构建输入不一致时拒绝，改走完整部署，不能伪造输入一致绕过检查。
- `check`：验证配置与路径，不代表服务健康。首次账户初始化仍由操作者执行。
- 构建失败不停止旧服务；迁移失败保持停止并保留数据，不启动旧后端写入可能已升级的结构。启动失败先查日志和真实运行状态，不自动回滚或重新初始化。

目录、入口类型和动作的完整参数见脚本用法。运行中的数据目录、实际配置及 `DEPLOYED_COMMIT` 不提交 Git；版本记录不能代替源码、镜像和运行实例的一致性检查。

## 运行参数与迁移

后端 CLI 选项、环境变量及默认值见 [`backend/src/main.rs`](../backend/src/main.rs)，也可查询所用版本的 `filehop serve --help`。调整传输参数前阅读 [Spec 002 的容量与超时契约](specs/002-desktop-file-transfer.md#6-容量与超时)：

- `FILEHOP_MAX_FILE_BYTES`、`FILEHOP_FILE_QUOTA_BYTES`、`FILEHOP_DISK_RESERVE_BYTES` 分别控制单文件限制、应用文件额度与磁盘余量；调低额度不自动删文件。
- `FILEHOP_TRANSFER_ACTIVE_LIMIT` 分别限制上传、下载和准备请求；页面串行不能替代服务器准入。
- 准备、上传无进展／总期限及下载无进展使用独立的 `FILEHOP_*_SECS` 参数；不要用 JSON 请求的短超时截断文件传输。上传客户端从认证限制快照取得总期限，加确认余量后使用；超时仍可能是结果未确认。
- Caddy 的 `FILEHOP_PROXY_CONNECT_TIMEOUT`、`FILEHOP_PROXY_RESPONSE_HEADER_TIMEOUT` 在入口环境中设置；后者从发送完请求体后等待响应头起算，不是文件体全程期限。更改入口须另行授权。

修改迁移前阅读[迁移维护规则](../backend/migrations/README.md)。已有实例的独立迁移调用、失败诊断及存活／就绪区别见[迁移与内部检查](production.md#迁移与内部检查)；生产仅使用受信任目标镜像，不从开发工作区编译程序直接迁移。

## GitHub Actions 与缓存

检查力度见[CI 与交付门槛](testing.md#4-ci-与交付门槛)。实际 job、版本、缓存键和文档白名单分别由 [workflows](../.github/workflows)、[`scripts/ci-scope.sh`](../scripts/ci-scope.sh) 维护。

涉及容器、代理、迁移、依赖或构建环境的变更，合并前在 Actions 的 **Application checks** 选择对应分支运行完整检查。手动入口须已存在于默认分支；基础检查成功不能代替容器与 HTTPS 检查。Android 检查入口见 [Android 指南](android.md#工具链与构建)。

缓存仅用于加速检查，不作为发布产物。宿主包缓存与 Docker 构建缓存互不共享；PR 的缓存不会自动成为其他 PR 的基分支缓存。依赖或基础镜像大幅更新后，可在 dev 手动运行完整检查预热缓存，不是正确性门槛。

排查缓存时，比较同一提交的两次完整检查：两次均须通过，第二次应出现适用缓存命中且仍执行测试。需要冷缓存时仅在临时分支调整缓存键，不删除共享缓存。Dockerfile 的依赖预编译层使用占位应用；新增 Cargo target、build.rs、路径依赖或 workspace 时需同步审阅该层，不能把占位构建当成真实应用验证。
