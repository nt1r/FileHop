# 发布与手动更新

对应 [Spec 004](specs/004-web-production-deployment.md) D03–D05。脚本和隔离冒烟不代表已正式发布或部署。生产操作、共享入口/网络、GitHub 设置及包可见性变更须分别授权。

## 发布前一次性准备及每版检查

沿用个人分支 → dev → main；`.github/workflows/release.yml` 仅接受本仓库 `vMAJOR.MINOR.PATCH` tag，提交必须属于受保护 main。使用 GitHub 托管 ARM64 runner，同一次提交构建后端和静态 Web，不使用 PR 缓存、PR 产物或 VPS 凭证。

经单独授权，由操作者在 GitHub 配置活动 **tag ruleset**：包含 `refs/tags/v*`（或全部 tag），没有排除项，限制创建、更新及删除；仅明确的发布操作者具有 bypass 权限，不给普通贡献者或不可信自动化 bypass。workflow 检查规则存在，权限主体仍需人工审查。禁止绕过规则移动已发布 tag。main 分支保护沿用已有设置。

每版按 [公开内容清单](../CONTRIBUTING.md#public-content-checklist) 核对代码及完整历史、构建上下文、依赖许可和必要声明。镜像包含 `/licenses`，Release 包含 Apache-2.0 LICENSE 和依赖声明归档；后端归档还包含基础系统 `/usr/share/doc`。文件收集不是法律兼容性判定，缺少的依赖声明或其他分发义务应先处理。确认后，由获授权操作者将仓库 Actions variable `FILEHOP_PUBLICATION_APPROVED_SHA` 设置为此次 main 的完整提交 SHA；此值不是秘密，不复用到别的提交。

创建 tag 前完成发布 PR 的完整检查。推送 tag 后 workflow 验证身份、构建 ARM64 镜像，运行目标产物隔离启动、迁移互斥和数据保留冒烟；存在正式旧 Release 时从最近发布后端种数据并由目标镜像迁移。当前没有旧发布结构，不新增空迁移或声称跨结构升级已验。

检查通过后先保留 draft Release，再推送唯一构建标签，以 digest 记录产物。**已有 Release（含 draft）拒绝覆盖**。公开包后必须用空 Docker 凭证目录匿名拉取成功，才上传完整附件并发布 Release。首次 GHCR 包通常需要另行授权改为 public；若因此失败，保留 draft 和镜像，操作者核查后手动完成该版本或放弃它并选择新版本，不盲目重新运行、不自动删除 draft 或覆盖旧版本。

Release 附件：

- `release.json`：版本、完整 Git SHA、后端和静态 Web 的 GHCR digest 引用。
- `web.tar.gz`：完整前端静态产物；运行时也可直接从静态镜像提取。
- `LICENSE`、`licenses.tar.gz`：项目许可及收集到的依赖许可/声明。
- `SHA256SUMS`：附件校验和。镜像本身由 registry digest 校验；不建立清单格式协商或独立签名平台。

只有构建和检查全部成功才发布完整 Release；失败可能留下 draft/镜像，但不代表版本可部署。Actions 不连接生产。

## 初始化与固定运行配置

宿主需要 Linux、Docker Compose、Node（使用仓库 `.nvmrc`）、`gh`、curl、util-linux `flock`。生产使用固定受信工具源码，不从 Release 下载执行脚本。`gh` 下载公开 Release 所需的本地认证不传进容器。

按[生产运行基础](development.md#隔离生产形态运行)准备独立的绝对数据库、文件目录、专用网络、UID/GID 10001 权限和存储初始化；首次安装使用目标 digest 镜像的 `init`，不是 `migrate`。网络须支持显式固定后端 IPv4，宿主 Caddy 通过该地址的 8080 访问，后端不发布端口。容器入口如需改为固定地址也必须单独授权，不让脚本修改共享入口。

复制 `deploy/update.example.json` 到仓库外固定配置目录，例如 `/srv/filehop-production/production.json`，逐项核对；数据目录和静态版本根目录必须存在、互不相同且不嵌套。静态根目录只放静态版本和 `current` 符号链接，不放数据库或上传目录。配置目录应仅允许运维用户写入；它将保存目标 Compose 和当前版本记录。实际地址、配置、日志与数据不提交 Git。

首次提取目标静态镜像 `/web` 到 `web/<version>`，通过 `web/current` 链接提供完整静态目录；让 Caddy 的 `FILEHOP_PROD_WEB_ROOT` 始终指向这个链接。首次后端用 `deploy/compose.production.yml` 和明确 env-file 初始化、启动，另加固定 `ipv4_address` overlay，并保持与 JSON 中的项目、网络、挂载、Origin、代理地址相同。先通过真实 HTTPS 日常路径再开始使用更新工具；更新入口不会替已有/损坏实例重新初始化。

Caddy 须加载 `deploy/caddy-production.routes` 中对 `/`、`/login`、`/files` 的页面回退规则。已有入口首次接入这些路由时，须另行授权更新并重载实际入口配置；更新脚本不会安装或修改共享 Caddy，仅更新前端制品不能让旧入口支持子路径。

## 更新

先保存文字草稿、结束上传下载，告知所有设备暂停操作。刷新会丢失内存队列；断连或 5xx 不证明发送未保存。随后：

```bash
node scripts/update.mjs check /srv/filehop-production/production.json v1.2.3
FILEHOP_CONFIRM_STOP=yes node scripts/update.mjs update /srv/filehop-production/production.json v1.2.3
```

`check` 只验证配置与版本，不证明网络、运行栈或存储健康。`update` 取得全机 `/run/lock/filehop-update.lock`，校验完成的稳定 Release 和固定仓库 digest、拉取 linux/arm64 产物、核对镜像版本/SHA 标签、完整提取静态资源；随后核对旧项目的真实数据挂载，停旧后端，使用目标镜像执行独立 `migrate`，切换静态链接并启动同版后端。后端存储锁继续阻止项目外的其他写入者；不要通过别的 Docker 命令与更新并发。

每次执行将输出保留到配置目录中权限 0600 的 `update-<时间>-<进程>.log`（含迁移输出）；锁冲突也返回非零，不执行下载或停服。日志可能含本机路径，仅保留本地，不公开原始日志。

更新生成 `<配置目录>/target.compose.json`，不继承 shell `COMPOSE_*`、工作目录 `.env` 或开发挂载。以后对该生产栈的查询/启停使用这个文件，不再使用残留的旧镜像配置。内部就绪最多等待 60 秒，并检查 HTTPS `/api/status` 以及 `/`、`/login`、`/files` 的内容均与目标 index 一致；任一路径请求失败或返回错误内容都判定冒烟失败，并提示核查已安装的 Caddy 页面路由；之后才原子记录 `current-release.json`。脚本不保存凭证或做认证业务写入，操作者仍须刷新页面并走一次登录、文本、上传下载/删除的日常路径。迁移成功前，目标配置保存在配置目录的 `pending-<版本>-<进程>.compose.json`，不会覆盖日常使用的 `target.compose.json`；成功后才原子替换运行配置。失败保留 pending 文件供排障，不直接用它启动服务。

前端完整提取后才切换，不暴露半套资源。已有目标版本目录拒绝覆盖（包括失败残留），更新并不是可恢复状态机。不得手动删除目录后无脑重跑；先调查实际镜像、结构、资源和运行状态，再明确下一步。

## 版本、日志、密码和排障

```bash
# 当前版本记录只有在更新就绪与 HTTPS 冒烟通过后写入；失败时以实际容器/静态链接为准。
node -p 'JSON.stringify(require("/srv/filehop-production/current-release.json"), null, 2)'
prod=(docker compose --env-file /dev/null --project-directory /srv/filehop-production \
  -p filehop-production -f /srv/filehop-production/target.compose.json)
"${prod[@]}" ps
"${prod[@]}" logs --tail 100 backend
# 日常重启，不执行迁移。
"${prod[@]}" restart backend
# 显式重置密码并撤销所有登录，密码经终端隐藏输入。
"${prod[@]}" exec backend filehop reset-password
```

更新失败立即停止后续步骤：保留挂载、容器日志、目标目录和 Compose 配置；迁移失败时 `target.compose.json` 仍是之前的配置（首次使用更新工具时可能尚不存在），保留它不代表允许启动旧版本；不自动回滚、清库、重写 SQLx checksum、重新初始化或重复迁移。迁移失败时旧服务保持停止；启动/冒烟失败时目标服务可能仍在运行或重启循环，先查日志，必要时用目标 Compose `stop backend`，**不要启动旧版本写入可能已升级的结构**。诊断期间站点可能不可用或静态资源已切换，这不是成功。

检查：目标来源/digest、真实挂载和 UID/GID、其他持锁进程、磁盘空间、已有迁移 checksum、固定后端地址、Caddy 的静态链接和精确 Origin。锁由进程退出释放，不删除存储身份文件解锁。日志轮转沿用 10 MiB × 3；不把 `unhealthy` 当自动重启。

数据为服务器明文，更新保留挂载不等于备份；本版没有备份恢复或自动回滚承诺，不能作为唯一副本。
