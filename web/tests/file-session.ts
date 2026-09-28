import { expect, type Page } from '@playwright/test'

export async function verifyFileSession(page: Page) {
  const task = (name: string) => page.locator('.upload-task').filter({ hasText: name })
  const prepared: string[] = []
  const queries: string[] = []
  const retired: string[] = []
  page.on('request', request => {
    const path = new URL(request.url()).pathname
    if (/\/api\/file-sends\/[^/]+$/.test(path) && request.method() === 'GET') queries.push(path)
    if (/\/attempts(?:\/[^/]+\/stop)?$/.test(path)) retired.push(path)
  })
  await page.route('**/api/file-sends', async route => {
    prepared.push(route.request().postDataJSON().send_id)
    await route.continue()
  })
  let release!: () => void
  const hold = new Promise<void>(resolve => { release = resolve })
  let arrived = false
  await page.route('**/api/file-sends/*/attempts/*/content', async route => {
    const response = await route.fetch()
    arrived = true
    await hold
    await route.fulfill({ response })
  }, { times: 1 })
  await expect(page.getByRole('button', { name: '选择文件' })).toBeEnabled()
  await page.locator('input[type="file"]').setInputFiles(['session-active.txt', 'session-wait.txt'].map(name => ({ name, mimeType: 'text/plain', buffer: Buffer.from(name) })))
  await expect.poll(() => arrived).toBe(true)
  await page.getByLabel('正文', { exact: true }).fill('session draft stays unsent')
  await page.clock.fastForward(43_200_000)
  await expect(page.getByRole('region', { name: '消息流' })).toHaveCount(0)
  await page.getByLabel('用户名').fill('Admin')
  await page.getByLabel('密码', { exact: true }).fill(' synthetic password ')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByRole('button', { name: '选择文件' })).toBeEnabled()
  release()
  await expect(task('session-active.txt')).toContainText('结果未确认：')
  await page.clock.fastForward(30_000)
  expect(queries).toHaveLength(0)
  expect(prepared).toHaveLength(1)
  await expect(task('session-wait.txt')).toContainText('等待上传')
  await task('session-active.txt').getByRole('button', { name: '查询文件结果' }).click()
  await expect(task('session-active.txt')).toContainText('上传成功')
  await expect(task('session-wait.txt')).toContainText('上传成功')
  expect(prepared).toHaveLength(2)
  expect(retired).toHaveLength(0)
  await expect(page.getByLabel('正文', { exact: true })).toHaveValue('session draft stays unsent')
  await expect(page.getByRole('article').filter({ hasText: 'session draft stays unsent' })).toHaveCount(0)
  await page.unrouteAll({ behavior: 'wait' })
  await page.getByLabel('正文', { exact: true }).fill('')
  await page.reload()
  await expect(page.getByRole('button', { name: '选择文件' })).toBeEnabled()
}
