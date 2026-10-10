# 按风险选择验证

本指南提供补充验证的执行入口，不保存某次运行结果。先完成[开发指南的本地检查](development.md#本地检查)，再按改动风险选择下列分支；执行频率、证据复用和完成判定以[测试原则](testing.md)为准。

所有故障注入使用真实但隔离的临时 SQLite、文件目录和合成数据。检查清理路径及资源归属，避免覆盖已有镜像或连接运行中的实例；生产只执行获授权的非破坏性检查。结果绑定实际提交，按[证据规则](testing.md#5-与-spec-的对应及完成判定)记录在 Issue／PR／CI。

## 验证入口

| 改动涉及 | 主要入口 | 补充边界 |
| --- | --- | --- |
| 账户、初始化和会话 | `backend/tests/initialization.rs`、`scaffold.rs`、`session.rs`、`session_process.rs`；浏览器初始化、会话、退出流程 | 原生认证还读 Spec 005；代理来源和真实剪贴板需对应环境验证 |
| 文本发送、分页和同步 | `backend/tests/messages.rs`；`web/tests/messages.ts`、`send-recovery.ts`、`history.ts`、`sync.ts` | 真实输入法、阅读位置与前后台行为按需人工确认（S001-A02–A13） |
| 上传、容量和恢复 | `backend/tests/files.rs`、`files_failure.rs`、`files_timeout.rs`、`files_process.rs`；`web/tests/files.ts`、`upload.spec.ts`、`file-session.ts`、`file-logout.ts` | 资源与长传输另见下节；到期后文件批次处理见 Spec 007 R05 |
| 文件管理与删除 | `web/tests/server-files.spec.ts`、`deletion-ordering.spec.ts`；上述后端文件测试 | 浏览器冲突注入不证明真实 TCP 竞争；后端测试不证明用户理解确认文案或本地副本不变 |
| 存储生命周期、迁移和内部就绪 | `backend/tests/migration.rs`、`health.rs`、`files_process.rs` | 目标发布镜像还须通过隔离生产形态冒烟，测试不代表生产已升级 |
| 开发管理脚本、CI 范围选择 | `bash tests/dev_script.sh`、`bash tests/ci_scope.sh` | 假 Docker／临时 Git 仓库验证公开 CLI，不证明真实容器或远端规则已应用 |
| 发布及更新工具 | `node tests/release_cli.mjs`、`node tests/update_cli.mjs` | CLI 测试不代替目标产物启动或真实入口验证 |
| Android | [Android 验证边界](android.md#验证边界) | 构建与合成密钥签名冒烟不代替实际手机、正式签名覆盖更新 |

Rust 测试以 `cargo test --manifest-path backend/Cargo.toml --locked --test <测试名>` 选择；浏览器以 `bash tests/browser.sh <spec 路径>` 选择，辅助 `.ts` 流程由相应 spec 编排，不直接当作独立 spec。测试入口只说明如何复验，不表示当前提交已通过。

## 资源与长传输

传输实现、容量控制、认证成本、代理超时或运行环境变化时，选择对应检查：

```bash
cargo test --manifest-path backend/Cargo.toml --locked --test files_process bounded_memory -- --ignored --nocapture
cargo test --release --manifest-path backend/Cargo.toml --test session_process measure_login_budget -- --ignored --nocapture
bash tests/caddy_ingress.sh
```

- **文件资源**：只支持 Linux `/proc`；运行前清除覆盖默认值的 `FILEHOP_*` 传输环境变量。测试比较不同文件大小和并发的后端 RSS 与受管实体大小，预算和采样实现以 `files_process.rs` 为准。RSS 包含启动期分配，不含内核页缓存；实体采样不是磁盘分配块、代理暂存或整台主机预算，也可能遗漏短暂峰值。
- **登录预算**：目标环境需测量验证延迟和进程内存，为并发密码验证、SQLite 与传输留出资源。算法参数和并发上限以实际版本为准，单台机器的结果不是性能承诺。
- **代理长传输**：入口脚本需 Caddy、OpenSSL、Node、curl 及 GNU 工具，以临时证书和 HTTP 探针验证超过 15 秒的双向文件体与首响应超时。它不是完整应用，不验证真实 Cookie／Origin、生产 ACME 或稳定版 Chrome。

## 隔离容器与生产形态

需要 Docker、Compose、Cargo、Node/pnpm 和 GNU 工具；生产形态还需 Caddy、OpenSSL 及已安装的 Playwright Chromium。镜像必须来自待验证源码。以下生成本轮专属标签；保留同一 shell 环境执行，结束后仅处理这些标签，不清理既有镜像：

```bash
run_id="$(date +%s)-$$"
export FILEHOP_BACKEND_IMAGE="filehop-check-backend:$run_id"
export FILEHOP_WEB_IMAGE="filehop-check-web:$run_id"
export FILEHOP_PROD_WEB_IMAGE="filehop-check-static:$run_id"
docker build -f deploy/backend.Dockerfile -t "$FILEHOP_BACKEND_IMAGE" .
docker build -f deploy/web.Dockerfile -t "$FILEHOP_WEB_IMAGE" .
docker build -f deploy/web-production.Dockerfile -t "$FILEHOP_PROD_WEB_IMAGE" .
bash tests/compose_smoke.sh
bash tests/web_container_smoke.sh
bash tests/production_smoke.sh
```

- 开发容器冒烟检查初始化、重启／SIGKILL／保留挂载重建后的持久化，以及实际只读挂载下的 Vite 启动和敏感文件排除；使用调用者 UID/GID 和一次性目录，不发布端口或接入共享网络。
- 生产形态冒烟使用独立网络、默认 UID/GID 10001、一次性挂载和回环 HTTPS，检查静态资源、开发生产隔离、业务往返、挂载拒绝及重建。传入 `FILEHOP_PREVIOUS_BACKEND_IMAGE` 可从实际旧发布种数据再由目标迁移；未传入时不能宣称跨结构升级已验。变量只接受操作者核对过的可信旧镜像。
- 静态镜像是可提取制品，不是可启动 Web 服务。它没有默认命令；用 `docker create <image> /unused` 创建停止的容器，再用 `docker cp` 提取 `/web`，最后移除提取容器。
- 生产冒烟只信任本轮临时证书，Chromium 固定 HTTP/1.1，避免容器网络重建引发无关的 HTTP/2 `ERR_NETWORK_CHANGED`。不关闭全局 TLS 校验，不以此证明生产 HTTP/2、ACME 续签或真实部署通过。

只检查示例 Compose 语法时，可运行 `docker compose --env-file .env.example -f deploy/compose.dev.yml config --quiet`；它不创建目录或网络，也不证明运行环境可用。正式安装、迁移和更新使用[生产指南](production.md)，不把这些检查镜像当正式产物。

## 稳定版 Chrome 与真实入口

首次接入、相关平台行为变化或排障时，选择受影响的步骤。先确认待验证提交、最新稳定版桌面 Chrome 和已获授权的隔离账户／数据；环境不具备时记录阻塞，不为完成验证擅自部署、重置或修改共享入口。

已安装稳定版 Chrome 时，也可运行真实后端自动化：

```bash
pnpm -C web run build
FILEHOP_TEST_CHROME=1 bash tests/browser.sh
```

此命令仍使用回环测试环境，不代替下面的真实入口或人工交互。

| 风险 | 人工操作与通过依据 |
| --- | --- |
| 文本输入和复制 | 两个独立浏览器配置互发保留换行、缩进、HTML/URL 字面量的合成文本；真实输入法不误发，快捷键可用，复制完整正文。拒绝真实剪贴板权限时明确报失败；浏览器无对应设置时记录限制 |
| 分页和同步 | 超过 50 条合成历史连续加载；加载期间滚动、阅读旧消息时接收新增，位置符合预期；回到底部、前后台切换及短暂离线恢复后补齐且无重复 |
| 草稿和来源标签 | 交互后刷新／关闭检查尽力离开提醒；确认离开后不恢复或自动发送草稿；标签变化只作用于新发送 |
| 认证与未知结果 | 对照现有自动化场景确认未知发送提示、文本放弃确认、同页重登及跨标签页退出后内容隐藏；到期文件等待项及 File 引用丢弃，重登仅手动处理未知结果，不接续旧批次。不增加公开故障钩子 |
| 上传与下载 | 合成文件在受控速率下持续上传／下载超过 15 秒，内容、名称和进度正确；检查串行、多选、本地中断及结束本轮提示，不把中断或 100% 进度当提交结果 |
| 服务器删除 | 确认指定文件和影响提示，仅文件页可删除；手动刷新后清理与容量反馈正确、历史保留、本地下载副本不变；实际下载以服务器裁决 |
| 开发入口 | 受信任证书、页面/API/HMR 同域 HTTPS/WSS 443；未通过外层认证均被拒绝，应用退出不声称退出 Basic Auth。应用未登录的文件请求、Web 错误 Origin 写请求拒绝；内部端口不可公网直达 |
| 隐私 | 仅审阅已授权的测试日志和拟公开材料，排除正文、凭证及机器识别信息；不读取无关服务日志来搜集证据 |

生产首次接入使用[日常使用确认](production.md#首次接入与日常使用确认)，不在生产注入故障。代理头处理由受控配置与隔离测试交叉核对；外部探测不代替云规则审阅，首次证书签发不等于实测续签。

只为本次适用的检查记录提交、操作、预期、结果及未验证部分；已有未受影响的证据直接复用。浏览器／系统具体版本、截图及环境细节留在私有记录，公开只保留必要类别和结论。待确认仍标待确认，不因自动化全绿写成通过，也不重新开启旧阶段的完整验收循环。
