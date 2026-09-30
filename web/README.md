# FileHop Web

Vite 官方 `react-ts` 模板，React + TypeScript + Cloudflare Kumo。
使用 Kumo standalone 样式，不额外引入 Tailwind 构建链。

页面文案与组件取舍遵循[产品基线的 Web 界面内容规范](../docs/product.md#web-界面内容规范)，首页及登录/消息工作区的展示约束见 [Spec 001](../docs/specs/001-desktop-text-loop.md#页面展示约束)。

工具链、开发入口、安全约束及验证命令见 [开发指南](../docs/development.md)。
`pnpm run dev` 仅供受控的 Compose 网络使用，不得直接发布到公网。
