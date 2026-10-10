# FileHop Web

Vite 官方 `react-ts` 模板，React + TypeScript + Cloudflare Kumo。
使用 Kumo standalone 样式，不额外引入 Tailwind 构建链。

## 颜色约定

- 当前仅支持浅色主题。基础表面、文字、边框、焦点与状态反馈直接使用 Kumo CSS token，不在应用中覆盖整套 Kumo 配色。
- `src/theme.css` 是 FileHop 补充颜色的唯一入口：来源标签配色、文件类型、存储分类及少量强调色派生。优先引用 Kumo token，不在组件或布局样式中硬编码色值。
- `src/index.css` 管理布局及样式应用；Kumo 按钮优先使用原生 variant 和 hover／disabled／focus 状态，不用背景覆盖与内部渐变竞争。
- `src/sourceColor.ts` 只将来源标签映射到稳定的配色标识；头像、来源标签和消息气泡共用映射，颜色不代表真实设备身份。文件类型和存储分类色不表示成功、警告或错误状态。
- Kumo 的 `--color-kumo-brand` 与 `--text-color-kumo-brand` 并非同色：蓝色主操作使用前者，链接文字使用 `--text-color-kumo-link`，不要按名称机械替换。

页面文案与组件取舍遵循[产品基线的 Web 界面内容规范](../docs/product.md#web-界面内容规范)，首页及登录/消息工作区的展示约束见 [Spec 001](../docs/specs/001-desktop-text-loop.md#页面展示约束)。

工具链、开发入口、安全约束及验证命令见 [开发指南](../docs/development.md)。
`pnpm run dev` 仅供受控的 Compose 网络使用，不得直接发布到公网。
