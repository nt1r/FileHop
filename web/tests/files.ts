import { expect, type Page } from '@playwright/test'

export async function verifyFiles(page: Page) {
  const picker = page.locator('input[type="file"]')
  await expect(page.getByText('单文件上限 1,024 字节', { exact: false })).toBeVisible()
  await expect(page.getByRole('button', { name: '选择文件' })).toBeEnabled()
  await picker.setInputFiles({ name: 'oversized.txt', mimeType: 'text/plain', buffer: Buffer.alloc(1025) })
  await expect(page.getByText('文件超过服务器单文件上限')).toBeVisible()
  const otherContext = await page.context().browser()!.newContext({ baseURL: new URL(page.url()).origin })
  const other = await otherContext.newPage()
  await other.goto('/')
  await other.getByLabel('用户名').fill('Admin')
  await other.getByLabel('密码', { exact: true }).fill(' synthetic password ')
  await other.getByRole('button', { name: '登录', exact: true }).click()
  let finish!: () => void
  let committed!: () => void
  const hold = new Promise<void>(resolve => { finish = resolve })
  const started = new Promise<void>(resolve => { committed = resolve })
  await page.route('**/api/file-sends/*/attempts/*/content', async route => {
    const response = await route.fetch()
    committed()
    await hold
    await route.fulfill({ response })
  })
  await picker.setInputFiles({ name: 'single-upload.txt', mimeType: 'text/plain', buffer: Buffer.from('single file') })
  await started
  await expect(page.getByText('上传成功')).toHaveCount(0)
  await page.getByLabel('正文', { exact: true }).fill('text independent of file')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(page.getByRole('article').filter({ hasText: 'text independent of file' })).toHaveCount(1)
  finish()
  await expect(page.getByText('上传成功')).toBeVisible()
  await page.unroute('**/api/file-sends/*/attempts/*/content')
  await other.getByRole('button', { name: '读取最近消息' }).click()
  const file = other.getByRole('article').filter({ hasText: 'single-upload.txt' })
  await expect(file).toHaveCount(1)
  const [download] = await Promise.all([other.waitForEvent('download'), file.getByRole('link', { name: '下载附件' }).click()])
  expect(download.suggestedFilename()).toBe('single-upload.txt')
  expect(await download.failure()).toBeNull()
  await otherContext.close()

  await page.route('**/api/files/*', route => route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ code: 'file_not_found', message: '文件不可用' }) }))
  await page.getByRole('article').filter({ hasText: 'single-upload.txt' }).getByRole('link', { name: '下载附件' }).click()
  await expect(page.getByText('无法开始下载：', { exact: false })).toBeVisible()
  await page.unroute('**/api/files/*')

  await page.route('**/api/transfer-limits', route => route.abort())
  await picker.setInputFiles({ name: 'offline.txt', mimeType: 'text/plain', buffer: Buffer.from('offline') })
  await expect(page.getByText('限制未知或离线', { exact: false })).toBeVisible()
  await expect(page.getByRole('button', { name: '选择文件' })).toBeDisabled()
  await expect(page.getByText('offline.txt')).toHaveCount(0)
  await page.unroute('**/api/transfer-limits')
  await page.getByRole('button', { name: '重查文件限制' }).click()
  await expect(page.getByRole('button', { name: '选择文件' })).toBeEnabled()

  // 后端已提交但 PUT 响应丢失：既不能报告失败，也不能生成新身份自动重发。
  let puts = 0
  await page.route('**/api/file-sends/*/attempts/*/content', async route => {
    puts++
    const response = await route.fetch()
    await route.fulfill({ response, status: 502, contentType: 'text/plain', body: 'lost' })
  })
  await picker.setInputFiles({ name: 'unknown-upload.txt', mimeType: 'text/plain', buffer: Buffer.from('unknown') })
  await expect(page.getByText('结果未确认：', { exact: false })).toBeVisible()
  expect(puts).toBe(1)
  await expect(page.getByRole('button', { name: '选择文件' })).toBeDisabled()
  await page.unroute('**/api/file-sends/*/attempts/*/content')
  await page.getByRole('button', { name: '查询文件结果' }).last().click()
  await expect(page.getByText('上传成功').last()).toBeVisible()
  expect(puts).toBe(1)
  await page.reload()
  await expect(page.getByText('unknown-upload.txt')).toHaveCount(1) // 历史可见，但任务不恢复。
  await expect(page.getByText('结果未确认：', { exact: false })).toHaveCount(0)
  expect(puts).toBe(1)

  // 第一次传输缺字节而明确失败，清理完成后用原文件引用从头重试。
  await page.route('**/api/file-sends/*/attempts/*/content', async route => {
    const response = await route.fetch({ postData: 'x' })
    await route.fulfill({ response })
  }, { times: 1 })
  await picker.setInputFiles({ name: 'retry-file.txt', mimeType: 'text/plain', buffer: Buffer.from('retry') })
  await expect(page.getByText('上传失败：', { exact: false })).toBeVisible()
  await page.getByRole('button', { name: '同次重试文件' }).last().click()
  await expect(page.getByRole('article').filter({ hasText: 'retry-file.txt' })).toHaveCount(1)
  await expect(page.getByText('上传成功').last()).toBeVisible()

  // 退出时即使上传成功的旧回调迟到，也不能重新显示已清空的本页任务。
  let release!: () => void
  let arrived!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const received = new Promise<void>(resolve => { arrived = resolve })
  await page.route('**/api/file-sends/*/attempts/*/content', async route => {
    const response = await route.fetch()
    arrived()
    await held
    await route.fulfill({ response })
  })
  await picker.setInputFiles({ name: 'late-file.txt', mimeType: 'text/plain', buffer: Buffer.from('late') })
  await received
  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: '退出登录' }).click()
  await expect(page.getByRole('region', { name: '消息流' })).toHaveCount(0)
  release()
  await page.unrouteAll({ behavior: 'wait' })
  await expect(page.getByText('late-file.txt')).toHaveCount(0)
  await page.getByLabel('用户名').fill('Admin')
  await page.getByLabel('密码', { exact: true }).fill(' synthetic password ')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByRole('article').filter({ hasText: 'late-file.txt' })).toHaveCount(1)

  let releaseExpiry!: () => void
  let arrivedExpiry!: () => void
  const expiryHold = new Promise<void>(resolve => { releaseExpiry = resolve })
  const expiryReceived = new Promise<void>(resolve => { arrivedExpiry = resolve })
  await page.route('**/api/file-sends/*/attempts/*/content', async route => {
    const response = await route.fetch()
    arrivedExpiry()
    await expiryHold
    await route.fulfill({ response })
  })
  await expect(page.getByRole('button', { name: '选择文件' })).toBeEnabled()
  await picker.setInputFiles({ name: 'expired-file.txt', mimeType: 'text/plain', buffer: Buffer.from('expired') })
  await expiryReceived
  await page.clock.fastForward(43_200_000)
  await expect(page.getByRole('region', { name: '消息流' })).toHaveCount(0)
  releaseExpiry()
  await page.unrouteAll({ behavior: 'wait' })
  await expect(page.getByText('expired-file.txt')).toHaveCount(0)
  await page.getByLabel('用户名').fill('Admin')
  await page.getByLabel('密码', { exact: true }).fill(' synthetic password ')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByText('结果未确认：', { exact: false })).toBeVisible()
  await expect(page.getByRole('button', { name: '选择文件' })).toBeDisabled()
  page.once('dialog', dialog => dialog.accept())
  await page.reload()
  await expect(page.getByRole('region', { name: '消息流' })).toBeVisible()
}
