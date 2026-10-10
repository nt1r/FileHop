# FileHop Web

FileHop 的桌面 Web 客户端，使用 React、TypeScript 和 Cloudflare Kumo 构建。

## 开发

环境配置、运行方式和验证命令见[开发指南](../docs/development.md)。
开发服务仅供受控的 Compose 网络使用，不得直接暴露到公网。

## 界面与样式

界面采用浅色主题，使用 Kumo standalone 样式。通用颜色直接引用 Kumo token，应用配色集中维护在 [`src/theme.css`](src/theme.css)。

页面内容遵循[Web 界面内容规范](../docs/product.md#web-界面内容规范)。
