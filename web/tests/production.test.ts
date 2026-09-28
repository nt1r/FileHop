import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'

// 只由生产冒烟编排调用；不混入使用宿主静态文件的常规 *.spec.ts 回归。
test('extracted production page exchanges text and files over isolated HTTPS', async ({ browser }) => {
  const root = process.env.TEST_PRODUCTION_ROOT!
  const origin = process.env.TEST_BASE_URL!
  const devOrigin = process.env.TEST_DEV_URL!
  const verify = process.env.TEST_PRODUCTION_PHASE === 'verify'
  const context = await browser.newContext(verify ? { storageState: `${root}/session.json` } : {})
  const page = await context.newPage()
  const response = await page.goto(origin)
  expect(response!.status()).toBe(200)
  expect(response!.headers()['www-authenticate']).toBeUndefined()
  expect(response!.headers()['cache-control']).toBe('no-cache')
  const scripts = await page.locator('script[src]').evaluateAll(nodes => nodes.map(node => node.getAttribute('src')!))
  expect(scripts.length).toBeGreaterThan(0)
  for (const src of scripts) {
    expect(src).toMatch(/^\/assets\/.+\.js$/)
    expect((await page.request.get(origin + src)).status()).toBe(200)
  }
  expect((await page.request.get(`${origin}/assets/missing.js`)).status()).toBe(404)
  expect((await page.request.get(`${origin}/internal/live`)).status()).toBe(404)
  if (!verify) {
    expect((await page.request.get(`${origin}/api/messages`)).status()).toBe(401)
    await page.getByLabel('用户名').fill('admin')
    await page.getByLabel('密码', { exact: true }).fill(' synthetic password ')
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await expect(page.getByLabel('正文', { exact: true })).toBeVisible()
    await page.getByLabel('正文', { exact: true }).fill('production synthetic message')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await expect(page.getByRole('article').filter({ hasText: 'production synthetic message' })).toHaveCount(1)
    await expect(page.getByRole('button', { name: '选择文件' })).toBeEnabled()
    await page.locator('input[type="file"]').setInputFiles({ name: 'production-synthetic.txt', mimeType: 'text/plain', buffer: Buffer.from('synthetic file bytes\n') })
    await expect(page.locator('.upload-task').filter({ hasText: 'production-synthetic.txt' })).toContainText('上传成功')
    await context.storageState({ path: `${root}/session.json` })
  }
  await expect(page.getByRole('article').filter({ hasText: 'production synthetic message' })).toHaveCount(1)
  const attachment = page.getByRole('article').filter({ hasText: 'production-synthetic.txt' })
  await expect(attachment).toHaveCount(1)
  const downloaded = page.waitForEvent('download')
  await attachment.getByRole('link', { name: '下载附件' }).click()
  const download = await downloaded
  expect(download.suggestedFilename()).toBe('production-synthetic.txt')
  expect(await readFile((await download.path())!, 'utf8')).toBe('synthetic file bytes\n')
  const cookies = await context.cookies(origin)
  const cookie = cookies.find(c => c.name === '__Host-filehop')!
  expect(cookie.secure && cookie.httpOnly).toBe(true)
  // 独立开发入口仍需外层认证；即使手动转送生产 Cookie，也不能读取另一实例。
  const dev = await browser.newContext({ httpCredentials: { username: 'test', password: 'synthetic-ingress-password' } })
  const devPage = await dev.newPage()
  expect((await page.request.get(`${devOrigin}/api/status`)).status()).toBe(401)
  await devPage.goto(`${devOrigin}/api/status`)
  const result = await devPage.evaluate(async () => {
    const r = await fetch('/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: ' synthetic password ' }) })
    return r.status
  })
  expect(result).toBe(401)
  await dev.addCookies([{ name: cookie.name, value: cookie.value, url: devOrigin, secure: true, httpOnly: true, sameSite: 'Lax' }])
  expect(await devPage.evaluate(async () => (await fetch('/api/messages')).status)).toBe(401)
  expect(await devPage.evaluate(async () => (await fetch('/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'developer', password: ' synthetic password ' }) })).status)).toBe(200)
  expect(await devPage.evaluate(async () => (await (await fetch('/api/messages')).json()).messages)).toEqual([])
  const devCookie = (await dev.cookies(devOrigin)).find(c => c.name === '__Host-filehop')!
  const isolated = await browser.newContext()
  await isolated.addCookies([{ name: devCookie.name, value: devCookie.value, url: origin, secure: true, httpOnly: true, sameSite: 'Lax' }])
  expect((await isolated.request.get(`${origin}/api/messages`)).status()).toBe(401)
  await isolated.close()
  await dev.close()
  await context.close()
})
