import { expect, type Page } from '@playwright/test'

export async function verifyServerFiles(page: Page) {
  const names = ['navigation-a.txt', 'navigation-b.txt', 'navigation-c.txt', 'navigation-wait.txt']
  const releases = new Map<string, () => void>()
  let completed = 0
  await page.route('**/api/file-sends/*/attempts/*/content', async route => {
    const name = route.request().postData()!
    await new Promise<void>(resolve => releases.set(name, resolve))
    const response = await route.fetch()
    await route.fulfill({ response })
    completed++
  })
  await page.getByLabel('正文', { exact: true }).fill('navigation draft')
  await expect(page.getByRole('button', { name: '选择文件', exact: true })).toBeEnabled()
  await page.locator('input[type="file"]').setInputFiles(names.map(name => ({ name, mimeType: 'text/plain', buffer: Buffer.from(name) })))
  await expect.poll(() => releases.size).toBe(3)
  await page.getByRole('button', { name: '服务器文件', exact: true }).click()
  const listing = page.getByRole('region', { name: '服务器文件' })
  await expect(listing).toBeVisible()
  await expect(listing.getByText(names[0], { exact: false })).toHaveCount(0)
  releases.get(names[0])!()
  // 切页不能停止等待项接续；第四个请求在文件页仍会开始。
  await expect.poll(() => releases.size).toBe(4)
  for (const name of names.slice(1)) releases.get(name)!()
  await expect.poll(() => completed).toBe(4)
  await page.unrouteAll({ behavior: 'wait' })
  await listing.getByRole('button', { name: '刷新文件列表' }).click()
  const row = listing.getByRole('article').filter({ hasText: names[0] })
  await expect(row).toContainText('可用')
  const [download] = await Promise.all([page.waitForEvent('download'), row.getByRole('link', { name: '下载附件' }).click()])
  expect(download.suggestedFilename()).toBe(names[0])
  expect(await download.failure()).toBeNull()
  await page.getByRole('button', { name: '消息工作区' }).click()
  await expect(page.getByLabel('正文', { exact: true })).toHaveValue('navigation draft')
  for (const name of names) await expect(page.locator('.upload-task').filter({ hasText: name })).toContainText('上传成功')
  await page.getByLabel('正文', { exact: true }).fill('navigation unknown send')
  // 断连后服务器结果未知；切页不能解锁正文或偷偷重发。
  await page.route('**/api/messages', async route => {
    if (route.request().method() === 'POST') await route.abort()
    else await route.continue()
  })
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(page.getByRole('button', { name: '查询发送结果' })).toBeEnabled()
  await page.getByRole('button', { name: '服务器文件', exact: true }).click()
  await page.getByRole('button', { name: '消息工作区' }).click()
  await expect(page.getByLabel('正文', { exact: true })).toHaveValue('navigation unknown send')
  await expect(page.getByLabel('正文', { exact: true })).toHaveAttribute('readonly', '')
  await expect(page.getByRole('button', { name: '查询发送结果' })).toBeEnabled()
  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: '放弃确认', exact: true }).click()
  await page.getByLabel('正文', { exact: true }).fill('')
  await page.unrouteAll({ behavior: 'wait' })

  // 真实读取响应延迟到退出并重新登录后，不能恢复旧认证周期的文件列表。
  let release!: () => void
  let arrived!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const received = new Promise<void>(resolve => { arrived = resolve })
  await page.route('**/api/files', async route => {
    const response = await route.fetch()
    arrived()
    await held
    await route.fulfill({ response })
  }, { times: 1 })
  await page.getByRole('button', { name: '服务器文件', exact: true }).click()
  await received
  await page.getByRole('button', { name: '退出登录' }).click()
  await expect(listing).toHaveCount(0)
  await page.getByLabel('用户名').fill('Admin')
  await page.getByLabel('密码', { exact: true }).fill(' synthetic password ')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByRole('region', { name: '消息流' })).toBeVisible()
  const response = page.waitForResponse('**/api/files')
  release()
  await response
  await expect(listing).toHaveCount(0)
  await page.unrouteAll({ behavior: 'wait' })
}
