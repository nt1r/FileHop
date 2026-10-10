# FileHop

轻量、自托管的跨设备文本与文件交换工具，面向个人使用。

FileHop 通过自己的服务器提供一条私人消息流，用于传递文字、链接、命令片段和文件，无需选择接收设备。

> **桌面 Web 已正式自用；Android 文本客户端正在交付，真机及正式签名验收尚未完成。** Android 文件功能不在当前切片内。已有证据和剩余限制见[路线图](docs/roadmap.md)。

## 产品方向

核心方向如下；具体已实现范围以上述状态和路线图为准：

- **桌面 Web ↔ Android**：浏览器与原生 Android 应用共享消息历史。
- **纯文本交换**：保留换行和缩进，支持主动复制，不自动覆盖剪贴板。
- **文件传输**：经自建服务器上传和下载，管理服务器文件占用。
- **单用户私人空间**：一个实例服务一个用户，通过账户认证访问。
- **自托管**：使用 SQLite 和本地文件存储，无需独立数据库服务。

完整范围与交付进度见[产品说明](docs/product.md)和[路线图](docs/roadmap.md)。

## 适用范围

FileHop 用于临时交换文本与文件，不是网盘、目录同步工具或唯一备份。

- 桌面 Web 是目标客户端；不承诺手机浏览器体验。
- 不提供多用户注册、设备间直连、后台可靠同步或系统通知。
- 公网传输通过 HTTPS 保护；不提供端到端加密，也不承诺服务器数据静态加密。
- 不提供备份恢复能力，重要文件应另行保留副本。

## 技术方案

| 部分 | 技术 |
| --- | --- |
| 桌面 Web | React、Cloudflare Kumo |
| 后端 | Rust、Axum、Tokio |
| 数据库 | SQLite、SQLx |
| 运行与入口 | Docker Compose、Caddy |
| Android | Kotlin、Jetpack Compose |

## 部署与使用

- [生产指南](docs/production.md)：正式发布产物、首次部署、手动更新和排障。
- [Android 指南](docs/android.md)：APK 安装、服务器配置、正式签名和覆盖更新。

部署前核对版本、配置与独立数据挂载；不要将开发镜像或未完成的 draft Release 用作正式版本。

## 参与开发

欢迎通过 [GitHub Issues](https://github.com/nt1r/FileHop/issues) 反馈问题或讨论改进。

- [贡献指南](CONTRIBUTING.md)：分支与 PR 流程。
- [开发指南](docs/development.md)：工具链、构建、测试及隔离开发环境运行。
- [测试原则](docs/testing.md)：测试与验收要求。
- [Web 指南](web/README.md)：界面与样式约定。

## 许可证

本项目采用 [Apache License 2.0](LICENSE)。
