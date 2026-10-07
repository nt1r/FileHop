import { defineConfig } from '@playwright/test'

if (!process.env.TEST_BASE_URL) throw new Error('Run bash tests/browser.sh with isolated storage')

export default defineConfig({
  testDir: './tests',
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: { baseURL: process.env.TEST_BASE_URL, trace: 'retain-on-failure' },
  projects: [{ name: 'browser', use: { browserName: 'chromium',
    // 仅信任本次隔离入口证书的公钥，不使用全局忽略 HTTPS 错误。
    ...(process.env.FILEHOP_TEST_CERT_SPKI ? { launchOptions: { args: [
      `--ignore-certificate-errors-spki-list=${process.env.FILEHOP_TEST_CERT_SPKI}`,
      // 容器重建会触发宿主 IP 变化通知，Chromium 因此中断无关的 HTTP/2 请求。
      // 此冒烟验证迁移与数据保留，固定 HTTP/1.1 避免环境噪声；生产入口仍支持 HTTP/2。
      ...(process.env.TEST_PRODUCTION_ROOT ? ['--disable-http2'] : []),
    ] } } : {}),
    ...(process.env.FILEHOP_TEST_CHROME === '1' ? { channel: 'chrome' as const } : {}) } }],
})
