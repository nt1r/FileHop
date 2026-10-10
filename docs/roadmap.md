# FileHop 交付路线图

本页维护大阶段状态及 Spec／实施入口；详细进度和执行证据在主 Issue、PR 与 CI 中。范围见[产品基线](product.md)，完成判定与证据复用见[测试原则](testing.md)。按当前授权推进，不因路线图存在就自动实施或部署。

## 已有能力

| 切片 | 权威 Spec | 当前状态与实施入口 |
| --- | --- | --- |
| 桌面文本 | [001](specs/001-desktop-text-loop.md) | 已实现；[#4](https://github.com/nt1r/FileHop/issues/4) 保留旧人工记录缺口，不伪称补验，也不重开完整验收循环 |
| 桌面文件传输 | [002](specs/002-desktop-file-transfer.md) | 原版验收通过，见 [#33](https://github.com/nt1r/FileHop/issues/33)；后续交互精简见下节 |
| 服务器文件管理 | [003](specs/003-server-file-management.md) | 已实现；主 Issue [#52](https://github.com/nt1r/FileHop/issues/52) 复用 [#60](https://github.com/nt1r/FileHop/issues/60)／[PR #73](https://github.com/nt1r/FileHop/pull/73) 的桌面证据；后续交互精简见下节 |
| Web 生产部署 | [004](specs/004-web-production-deployment.md) | 已正式自用，见 [#74](https://github.com/nt1r/FileHop/issues/74)；运行方式见[生产指南](production.md) |

Web v0.1.0 的实际使用、保留挂载重建后的数据保留、云入站规则及独立外部网络检查已由用户确认，见 [#84](https://github.com/nt1r/FileHop/issues/84)。这是用户确认，不写成代理实测；旧任务关闭或范围收敛也不表示原计划全部实现。

## 流程精简

[Spec 007](specs/007-implemented-flow-simplification.md) 的 A 单入口删除与手动刷新、B 单轮发送及串行队列、C 登录失效后丢弃文件批次均已实现，**稳定版桌面 Chrome 人工确认仍待完成**，由 [#89](https://github.com/nt1r/FileHop/issues/89) 跟踪。Spec 002／003 的旧验收不能证明这些新交互已通过。

长期行为以 Spec 002／003 为准；精简不撤销既有认证、准备幂等、容量和清理恢复保护，不改变文本同次重试规则。

## Android

| 切片 | 权威 Spec | 当前状态与实施入口 |
| --- | --- | --- |
| 原生认证与文本 | [005](specs/005-android-text-loop.md) | 实施中，见 [#99](https://github.com/nt1r/FileHop/issues/99)；Web 正式自用前置已满足，真机及正式签名覆盖更新验收尚未完成 |
| 文件交换 | [006](specs/006-android-files.md) | 范围概要，待实现；先完成文本闭环，暂不拆实施票 |

S002-F17、S003-M13 的原生认证部分随 Spec 005 补验，不据后端集成或 APK 构建宣告手机交付。工具链、官方 SDK 构建、安装和待授权签名配置见 [Android 指南](android.md)。

## 完成标准

Web 和自己的手机能日常交换文本、文件；认证有效、资源有界、更新不误删数据，已知限制可接受即可。先用起来，再根据实际问题修复体验与兼容性。

备份恢复、高可用、实时推送、后台可靠传输、全平台适配、应用内本地文件管理及旧客户端兼容协议均不在当前承诺中。生产部署、共享入口／网络及远端设置仍需显式授权，文档和 Issue 更新不代表已部署。
