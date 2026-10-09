# Android 开发与安装

权威行为见 [Spec 005](specs/005-android-text-loop.md)。Android 文件上传、下载和服务器文件管理不在本切片内。

## 工具链与构建

首版以 Android 16（API 36）为最低及目标版本，不承诺旧系统兼容。使用 Kotlin 2.2.21、Compose、AGP 8.13.2、Gradle Wrapper 8.13、JDK 21（Java/Kotlin 字节码目标 17）；不依赖机器全局 Gradle 的版本。

Android 检查在 GitHub 托管 `ubuntu-24.04` x86-64 runner 上使用官方 SDK Platform 36 / Build Tools 36.0.0。开发 VPS 不安装第三方 ARM64 SDK、ADB 或模拟执行层。本地能编辑源码和运行 Rust 隔离测试，不据此宣称 Android 编译通过。

`.github/workflows/android-check.yml` 在 PR 到 dev/main 或手动触发时运行：

```bash
cd android
./gradlew --no-daemon :app:testDebugUnitTest :app:lintDebug :app:assembleDebug
```

`filehop-dev-<sha>` artifact 包含开发 APK，保留 7 天。只安装自己信任的提交构建，不将任意外部 PR APK 当作可信发布。Gradle Wrapper JAR 与下载的 Gradle 分发包均校验固定 SHA-256。

正式 application ID 为 `io.github.nt1r.filehop`，开发版为 `io.github.nt1r.filehop.dev`。两版设置、密钥和登录相互隔离。开发 APK 使用 runner 的临时 debug 签名，不保证不同构建可覆盖安装；签名不同时需要卸载开发版后重装，开发版数据会丢失。正式版必须沿用同一正式签名，不通过卸载实现更新。

## 首次配置与使用

- 首次填写并确认 HTTPS 域名根地址，不允许账户信息、路径、查询或片段；确认后固定，更换需清除应用数据。
- 源码构建的默认地址为保留示例地址 `https://filehop.example.invalid`，不是可连接的服务。正式构建通过 `-PfilehopDefaultOrigin=https://<正式域名>` 设置默认地址；用户仍须首次确认。真实部署地址不写入源码。
- 服务器须先具备 Spec 005 原生会话接口。已有实例通过受授权的正常发布/迁移流程应用 `0002_add_native_sessions.sql`，不重写 `0001`，不清库。合并客户端代码不会自动更新服务器。
- 使用现有账户登录，查看、发送及主动复制纯文本。文件消息仅展示文件名及暂不支持提示。
- 前台刷新与历史读取使用既有游标协议；结果未确认时手动查询、同次重试或放弃确认，不能把再次发送当作撤回。
- 草稿和消息只在进程内，旋转保留，进程终止不恢复。更新、卸载或清除数据前先保存草稿。
- Token 使用 Android Keystore AES-GCM 加密保存；密码不持久保存，备份和设备迁移排除应用数据。退出立即清理本机，撤销请求失败会提示，不保留专项撤销重试机制。
- 现有开发站点 Basic Auth 仍保持原样，当前 Android 不支持穿过此外层认证；不要关闭开发 Web 保护来接入手机。原生认证先用隔离 HTTP API 测试，真实手机 HTTPS 接入需单独配置/授权。

## 验证边界

Rust 原生认证测试使用公开 HTTP API 和真实临时 SQLite/文件目录；迁移测试从冻结的 v0.1.0 初始迁移建立合成旧实例。Android 单元测试只检查来源地址及正文/标签公共规则。

Actions 编译、Lint 和单元测试不能代替实际手机验证。首次安装后应走通与 Web 双向文本、复制、历史分页、前后台刷新、旋转及必要网络失败路径；正式签名覆盖更新另行验证。不得将未执行的步骤记录为通过。进度与具体结果留在主 Issue/PR，不在本文维护临时验收报告。
