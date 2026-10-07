# 独立宿主开发入口

本指南说明 FileHop 的可选宿主 Caddy 方案，不描述特定服务器。不是生产部署指南。

## 结构

- `deploy/Caddyfile.host`：独立入口全局配置，仅 TCP 443；禁用 HTTP 跳转、HTTP/3 和管理 API，使用 TLS-ALPN-01。
- `deploy/caddy-dev.routes`：页面/API/WSS 共同 Basic Auth，移除外层 Authorization，覆盖来源头，拒绝内部诊断路径。
- `deploy/filehop-caddy.service`：独立非 root 服务账户及证书目录，仅授予绑定低端口能力，不打印环境变量。
- `deploy/compose.host.yml`：为开发前后端设置专用网络固定地址，不发布应用端口。

入口与其他服务的配置、二进制和生命周期隔离。安装前确认授权、443 空闲、DNS/云网络和地址不冲突，不修改无关服务。

## 配置与安装

审阅 systemd 单元中的项目专用路径；安装受信任、固定版本的 Caddy 二进制，创建独立服务账户及配置目录，再安装 Caddyfile、路由文件和服务单元。不要盲目覆盖已存在的配置。

应用 `.env` 参考 `.env.example`，设置开发域名、专用内部 Docker 网络、后端/前端固定地址。网络使用 `--internal`；宿主入口通过该网络的桥地址访问应用，后端可信代理应设为实际观察到的精确来源地址，不是整个网段。

入口环境文件需要：

- `FILEHOP_DEV_HOST`：开发 FQDN。
- `FILEHOP_DEV_USER`、`FILEHOP_DEV_PASSWORD_HASH`：独立外层凭证，与应用账户不同。
- `FILEHOP_BACKEND_UPSTREAM`、`FILEHOP_WEB_UPSTREAM`：各服务的固定内部地址与端口。

环境文件只允许管理员和入口服务读取。通过隐藏交互或 stdin 生成密码哈希，不在命令行参数、聊天、日志或 Git 中放真实凭证。首次对外开放前必须先落实认证、完成配置校验。证书和自动保存配置也应受访问权限保护。

## 运行

准备独立开发数据目录，核对路径与 UID/GID 权限；应用不会自动初始化账户。使用宿主 overlay：

```bash
docker compose --env-file .env -f deploy/compose.dev.yml -f deploy/compose.host.yml config --quiet
docker compose --env-file .env -f deploy/compose.dev.yml -f deploy/compose.host.yml up --build -d
```

初始化参见[开发指南](development.md#显式初始化)。不得删除正在被容器挂载的工作目录或使用外层密码作为应用密码。

修改路由后，安装经过审阅的配置并执行：

```bash
sudo systemctl reload filehop-caddy
sudo systemctl status filehop-caddy --no-pager
```

ExecReload 先校验配置，再发送 SIGUSR1；检查 journal 和 HTTPS 响应确认异步重载成功。更改入口环境文件需在验证后重启独立服务，不能假定信号会刷新进程环境。需要停用时仅停止 FileHop 入口与应用，不删除持久数据。

## 验证

```bash
bash tests/caddy_ingress.sh
pnpm -C web exec tsc -b
```

入口测试使用临时证书、回环端口和上游探针，不安装系统信任；应用认证/存储仍由 Rust 和 Playwright 套件验证。真实验收还需可信 HTTPS、同域 WSS、外部端口检查及稳定版 Chrome。普通日志、HAR、trace 和公开证据不能包含凭证、用户正文、主机拓扑或个人设备详情。外部探测不替代云规则审阅，首次签发不证明到期续签已经实测。
