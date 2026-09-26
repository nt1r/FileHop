import { expect, type Page } from '@playwright/test'

export async function verifyFileLogout(page: Page) {
  const other = await page.context().newPage()
  await other.goto('/')
  await expect(other.getByRole('region', { name: '消息流' })).toBeVisible()
  const names = ['logout-active-a.txt', 'logout-active-b.txt', 'logout-active-c.txt', 'logout-wait.txt']
  const started: string[] = []
  const stopped: string[] = []
  let release!: () => void
  const hold = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/file-sends/*/attempts/*/content', async route => {
    const response = await route.fetch()
    started.push(route.request().postData()!)
    await hold
    await route.fulfill({ response })
  })
  await page.route('**/api/file-sends/*/attempts/*/stop', async route => {
    stopped.push(route.request().url())
    await route.continue()
  })
  await page.locator('input[type="file"]').setInputFiles(names.map(name => ({ name, mimeType: 'text/plain', buffer: Buffer.from(name) })))
  await expect.poll(() => started.length).toBe(3)
  await expect(page.locator('.upload-task').filter({ hasText: names[3] })).toContainText('等待上传')
  // 同源另一页发起退出也必须清空本页并尽力停止；无须在每个标签页再次确认。
  await other.getByRole('button', { name: '退出登录' }).click()
  await expect(page.getByRole('region', { name: '消息流' })).toHaveCount(0)
  await expect.poll(() => stopped.length).toBe(3)
  await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible()
  await page.getByLabel('用户名').fill('Admin')
  await page.getByLabel('密码', { exact: true }).fill(' synthetic password ')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByRole('region', { name: '消息流' })).toBeVisible()
  // 在新认证周期才交还旧响应：历史允许保留已提交文件，但不能复活旧任务或等待项。
  release()
  await page.unrouteAll({ behavior: 'wait' })
  await expect(page.locator('.upload-task')).toHaveCount(0)
  await expect(page.getByText(names[3], { exact: false })).toHaveCount(0)
  expect(started).toEqual(names.slice(0, 3))
  await other.close()
}
