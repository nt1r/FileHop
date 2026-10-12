# FileHop 品牌素材

`filehop-logo-source.png` 是用户选定的 AI 生成 Logo 原图（1254 × 1254，RGBA PNG），保留原始像素和来源元数据。不要用平台缩略图覆盖它。

## 平台资源

- Web：`web/src/assets/filehop-logo.png` 用于登录页和工作区；`favicon.ico` 包含 16/32/48px 帧。资源放在已有开发挂载的 `src` 内，由 Vite 构建为带哈希的静态文件，不增加公网目录或部署挂载。
- Android：`drawable-nodpi/filehop_logo.png` 与 Web 使用相同图形；`ic_launcher_foreground.png` 和 `ic_launcher_monochrome.png` 由 `mipmap-anydpi-v26/ic_launcher.xml` 引用，适用于本项目最低 API 36。系统决定圆形等裁切及主题色，不将圆角烘焙到前景。
- 自适应图标以 108dp 画布生成 432px 前景，主要图形位于 66dp 安全圆内；背景使用 `#F4F9F8`。Web 品牌容器使用 Kumo 浅色背景。

## 更新素材

安装已有 Web 开发依赖及 Playwright Chromium 后，在仓库根目录运行：

```bash
pnpm -C web install --frozen-lockfile
pnpm -C web exec playwright install chromium
node scripts/generate-brand-assets.mjs
```

脚本从原图测量可见边界、统一留白，输出缩放图、favicon 和 Android 单色轮廓；不调用图像模型、不读取运行配置。原图保持不变。平台衍生文件提交 Git，应用构建不需要运行此脚本。背景色如调整，应同步脚本与 Android 的 `values/colors.xml`。

素材更新后检查 Web 登录页/工作区的小尺寸效果，以及 Android 圆形裁切和主题图标；脚本生成或 APK 构建成功不能替代实际启动器显示检查。
