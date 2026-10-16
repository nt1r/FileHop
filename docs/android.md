# Android 开发与安装

权威行为见 [Spec 005](specs/005-android-text-loop.md) 与 [Spec 006](specs/006-android-files.md)。Android 支持文本与文件交换；服务器空间清理仍使用 Web 服务器文件页，不提供 Android 文件管理页。

## 工具链与构建

首版最低及目标版本为 Android 16（API 36），不承诺旧系统兼容。使用仓库 Gradle Wrapper，不依赖全局 Gradle；插件、Compose BOM 和依赖版本以 [`android/build.gradle.kts`](../android/build.gradle.kts)、[`app/build.gradle.kts`](../android/app/build.gradle.kts) 及 [Wrapper 配置](../android/gradle/wrapper/gradle-wrapper.properties) 为准。编译 SDK 升级不自动改变最低版本或目标系统行为。

Java 统一使用兼容的受支持 Amazon Corretto LTS，检查、正式发布及本地构建保持同一支持线。具体选择见 [Android checks](../.github/workflows/android-check.yml)。`setup-java` 的 Corretto 适配器按大版本和 `check-latest` 解析补丁，并非精确补丁锁定；实际版本以日志为准。如需严格补丁复现，使用固定官方归档及摘要；升级 LTS 须显式提交和验证。

AGP 使用内置 Kotlin；较新的 KGP 在根脚本覆盖，不重复应用 `org.jetbrains.kotlin.android`。Compose 库由稳定 BOM 管理，直接依赖核对 Google Maven／Maven Central，间接依赖遵循上游约束，不为版本号无差别强制覆盖或更换测试平台。升级参考 [AGP](https://developer.android.com/build/releases/agp-9-4-0-release-notes)、[内置 Kotlin](https://developer.android.com/build/migrate-to-built-in-kotlin)、[Kotlin 兼容表](https://kotlinlang.org/docs/gradle-configure-project.html)及 [Gradle 兼容表](https://docs.gradle.org/current/userguide/compatibility.html)；超出上游完全支持表的组合，以实际构建、Lint、测试和签名冒烟验证，不宣称上游全矩阵认证。

构建使用 GitHub 托管 Linux x86-64 runner 和官方 SDK，版本及归档校验见 [`scripts/setup-android-sdk.sh`](../scripts/setup-android-sdk.sh)。开发 VPS 不安装第三方 ARM64 SDK、ADB 或模拟执行层；本地源码编辑或 Rust 测试不证明 Android 编译通过。

`.github/workflows/android-check.yml` 在 PR 到 dev/main 或手动触发时运行：

```bash
cd android
./gradlew --no-daemon :app:testDebugUnitTest :app:lintDebug :app:assembleDebug
```

同一 job 还通过 `tests/android_release_smoke.sh` 使用一次性合成密钥检查 release 构建、签名校验、正式 application ID/versionCode 和非调试属性；该 APK 不发布，不能代替正式密钥或手机覆盖更新验收。

`filehop-dev-<sha>` artifact 包含开发 APK，保留时间以 workflow 为准。只安装自己信任的提交构建，不将任意外部 PR APK 当作可信发布。Gradle Wrapper JAR 与下载的 Gradle 分发包均校验固定 SHA-256。

正式 application ID 为 `top.hammerbilly.filehop`，开发版为 `top.hammerbilly.filehop.dev`。两版设置、密钥和登录相互隔离。开发 APK 使用 runner 的临时 debug 签名，不保证不同构建可覆盖安装；签名不同时需要卸载开发版后重装，开发版数据会丢失。正式版必须沿用同一正式签名，不通过卸载实现更新。

application ID 不同即为另一款应用，不能覆盖安装或继承其设置与凭证；需要重新配置和登录，不自动卸载旧包或删除数据。应用标识不是服务器地址，不改变已确认的 origin。

## 首次配置与使用

- 首次填写并确认 HTTPS 域名根地址，不允许账户信息、路径、查询或片段；地址保存在本机。登录页、会话检查页及消息页均可通过“更换服务器”修改，无需旧服务器在线。规范化后相同地址不退出，不同地址需确认清除本机旧登录、草稿和未确认发送上下文，然后重新登录；不自动尝试旧 Token。
- 公开 APK 与开发 APK 均不预置服务器地址；首次输入框留空，`https://filehop.example.invalid` 仅为占位提示，不是可连接的服务。每位用户填写自己部署的 HTTPS 根地址，并使用该实例的账户登录；无需按服务器分别构建 APK。升级保留已经确认的地址和设置。
- 服务器须先具备 Spec 005 原生会话接口。已有实例通过受授权的正常发布/迁移流程应用 `0002_next_release.sql`，不重写 `0001`，不清库。合并客户端代码不会自动更新服务器。
- 使用现有账户登录，查看、发送及主动复制纯文本。文件消息展示文件名、大小、来源和已知状态；可用文件可下载保存，实际可用性以服务器为准。
- 更换地址前等待当前文本发送/查询结束，并完成或明确结束上传批次、取消/结束下载保存；系统文件或保存位置选择器尚未返回时也不能更换。结果未确认时先检查原服务器历史，放弃本机上下文不等于撤回。取消更换保持原样。更换不删除服务器记录或已保存文件，也不保存多套会话；切回原地址仍须登录。更换只清除本机凭证，不承诺撤销旧服务器会话；其固定有效期不变。
- 前台刷新与历史读取使用既有游标协议；文本结果未确认时手动查询、同次重试或放弃确认，不能把再次发送当作撤回。文件未确认结果的处理见下节。
- 草稿和消息只在进程内，旋转保留，进程终止不恢复。更新、卸载或清除数据前先保存草稿。
- Token 使用 Android Keystore AES-GCM 加密保存；密码不持久保存，备份和设备迁移排除应用数据。退出立即清理本机，撤销请求失败会提示，不保留专项撤销重试机制。
- 开发站点 `/api/*` 使用 FileHop 自身认证，不要求 Caddy Basic Auth；APK 使用开发实例账户登录，不能填写外层入口账户。页面、源码和热更新仍受 Basic Auth 保护。实际入口须经授权应用新版路由，开发后端须已支持原生会话；仅构建 APK 不会更新入口或后端。

## 文件发送与系统保存

- 点击“选择文件发送”打开系统多选，选中后按提供方返回的选择顺序自动串行上传；同一批次可继续选择以追加文件，等待项可单独移除。等待项只留进程内，不提前复制文件内容或申请服务器额度。每项保留结果，失败文件需重新选择，属于新发送。
- 当前文件先检查服务器限制，再按限制流式生成一个私有临时快照并发送；不依赖手机上的真实路径，也不申请全盘管理权限。大小以实际读取为准，空文件可发送；无法读取、过大或空间不足会提示。成功或明确失败并清理完成后继续下一项；清理失败暂停新的暂存，处理本机空间问题后可重试清理。
- “中断传输”只停止当前本机上传，不撤回服务器任务。数据达到 100% 仍需等待服务器确认；结果未确认时整个上传队列暂停，只能手动查询或“结束本轮”，不自动查询或重传。手动查询确认成功或终结失败后继续等待项；结束本轮中断本机上传并清空全部等待项和上传上下文，重新选择前先检查历史，避免重复发送。
- 从文件消息点击下载，通过系统创建文档流程选择保存位置；取消选择不报错，也不开始下载。先下载到私有临时文件，再写入选定位置，界面区分下载中、保存中和保存成功，全部写入并关闭成功后才报告成功。
- 下载或保存期间可取消；失败或取消可能留下不完整目标，应用尽力清理，但仍需在系统文件管理器检查。选择新文件，避免覆盖重要内容；名称、覆盖和备份由系统选择流程及提供方决定，不承诺跨提供方原子保存。失败后需主动从头重下。
- 一个上传与一个下载可同时进行，文本发送独立；上传结果未确认不阻止下载，结束上传批次不取消下载，取消下载也不结束上传。只允许一个系统选择器在途；从选择器返回且应用在前台后才启动新的文件任务。
- 旋转保留进程内批次，不重复发送。切后台不主动取消或暂停已经开始的单文件任务，但不启动下一文件；不保证后台或锁屏后完成。进程终止不恢复文件队列，重启清理私有临时数据；登录失效丢弃全部等待项和文件引用、中断未完成的下载/保存，重登后只能手动处理保留的未确认发送身份，文件须重新选择或主动下载。主动退出还清空未确认身份，不撤回服务器内容或已保存副本。
- 完整本地副本交给系统文件管理器打开和删除，不依赖 FileHop 登录或服务器在线；服务器删除不影响副本，卸载/清除 FileHop 数据不主动删除系统保存的文件。应用不保留副本索引或长期 URI 授权。私有临时文件清理失败会如实提示，不将已完整保存的副本误判为失败或删除。
- 服务器文件删除等已知状态通过手动刷新或重入校正，常规新增消息轮询不持续查询删除进度；释放服务器空间请使用 Web 服务器文件页。

## 正式签名与手动更新

`.github/workflows/android-release.yml` 提供 **Publish Android APK** 手动入口，只允许从本仓库受保护 `main` 运行。输入已发布的 Web/后端版本 tag；工作流验证该 tag 的提交在 main 上、与 `FILEHOP_PUBLICATION_APPROVED_SHA` 相同，从该提交重新构建，不消费 PR artifact 或 PR 缓存。APK 附加到同一个 GitHub Release，不另建会干扰服务器发布顺序的 Release。

操作者需另行授权并配置以下仓库 Secrets/Variables；提交 workflow 不代表这些设置已生效：

| 类型 | 名称 | 用途 |
| --- | --- | --- |
| Secret | `FILEHOP_ANDROID_KEYSTORE_BASE64` | 固定正式 keystore 的 Base64 内容（Base64 不是加密） |
| Secret | `FILEHOP_ANDROID_STORE_PASSWORD` | keystore 密码 |
| Secret | `FILEHOP_ANDROID_KEY_ALIAS` | 正式签名条目别名 |
| Secret | `FILEHOP_ANDROID_KEY_PASSWORD` | 签名条目密码 |
| Variable | `FILEHOP_ANDROID_CERT_SHA256` | 预先确认的签名证书 SHA-256，64 位小写十六进制，无冒号 |
| Variable | `FILEHOP_PUBLICATION_APPROVED_SHA` | 复用服务器发布的逐提交公开检查批准 |

签名密钥由操作者在可信环境创建并保留独立加密副本，不能只存在 GitHub Secrets。不要把 keystore、密码、真实内容或本机路径放进 PR、日志或仓库。证书可被 APK 使用者读取，创建时使用通用应用主体，不写入私人身份。工作流只在签名步骤注入秘密，临时 keystore 使用限制权限并在退出时删除；签名证书指纹不匹配时拒绝上传，不能用新密钥静默替换正式签名。

`versionCode = MAJOR × 1,000,000 + MINOR × 1,000 + PATCH`，minor/patch 各小于 1000，结果须为正数且不超过 2,100,000,000；正式版本必须高于已有 Android 发布。应用 ID 和密钥不变。工作流拒绝覆盖已有 APK/元数据，不自动重试部分发布；失败后先检查 Release 和签名状态，再人工处理，不删除已发布资产绕过保护。

发布资产为 `filehop.apk`、`android-release.json` 和 `android-SHA256SUMS`。用户从可信仓库 Release 下载 APK，在系统确认安装；后续下载更高版本直接覆盖安装正式版，不卸载。若系统提示签名不一致，停止更新并核对产物，不通过卸载正式版掩盖问题。来源站点和签名证书指纹应与操作者确认的值一致，校验和本身不能替代来源信任。

更新前保存草稿；Web/后端不兼容更新时同步更新 APK，不承诺旧客户端兼容或进程内草稿恢复。不建设应用内自动更新。首次正式安装及一次同签名覆盖更新必须在实际手机验证，发布成功本身不是 A04 通过。

## 界面字符串规范

- 应用提供的按钮、标题、输入标签、确认说明、反馈及无障碍文案放入 `android/app/src/main/res/values/strings.xml`，按语义命名（如 `action_send`、`notice_send_unconfirmed`），不在 Compose 或 ViewModel 中硬编码。当前默认资源保留中文，不为资源化额外增加翻译。
- Compose 用 `stringResource()` 按当前资源配置解析；当前反馈状态保存带 `@StringRes` 注解的资源 ID，`null` 表示无反馈，不在 ViewModel 中预先解析并缓存某种语言的文案。非 Compose 初始化需要字符串时使用 `Context.getString()`，不为取文案持有 Activity。
- 带数值的文案使用资源占位符（如 `%1$d`），不拼接句子；需要复数规则时使用 `plurals` / `pluralStringResource()`。不要把提示和按钮文案当作业务状态或协议标识。
- `FileHop` 产品名和稳定的默认来源标签 `Android` 标为 `translatable="false"`。已保存的用户来源标签、正文、文件名及服务器地址属于数据，原样展示，不翻译或重写。API 路径、JSON 字段、错误码、存储键等技术常量不放进字符串资源。

## 验证边界

Rust 原生认证与文件测试使用公开 HTTP API 和真实临时 SQLite/文件目录；迁移测试从冻结的 v0.1.0 初始迁移建立合成旧实例。Android 少量单元测试检查来源地址、正文/标签及文件状态合并等公共纯规则，不建立私有组件测试矩阵。

Actions 编译、Lint 和单元测试不能代替实际手机验证。首次安装后应走通与 Web 双向文本、复制、历史分页、前后台刷新、旋转及必要网络失败路径；文件功能按 Spec 006 在实际选择/保存提供方上验证双向交换、多选追加与串行等待、上传下载文本共存、未知结果及批次结束、系统保存和生命周期。无需每次修改重复未受影响的全套验证；正式签名覆盖更新另行验证。不得将未执行的步骤记录为通过。进度与具体结果留在主 Issue/PR，不在本文维护临时验收报告。
