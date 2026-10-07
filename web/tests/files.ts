import { expect, type Page } from '@playwright/test'

export async function verifyFileQueue(page: Page) {
  const picker = page.locator('input[type="file"]')
  const task = (name: string) => page.locator('.upload-task').filter({ hasText: name })
  const file = (name: string) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(name) })
  const releases = new Map<string, () => void>()
  const prepared: string[] = []
  await page.route('**/api/file-sends', async route => {
    prepared.push(route.request().postDataJSON().name)
    await route.continue()
  })
  await page.route('**/api/file-sends/*/attempts/*/content', async route => {
    const name = route.request().postData()!
    await new Promise<void>(resolve => { releases.set(name, resolve) })
    // 一个文件明确失败不应阻止后面的等待项；其余请求仍使用真实后端提交。
    const response = await route.fetch(name === 'queue-b.txt' ? { postData: 'x' } : {})
    await route.fulfill({ response })
  })
  await expect(page.getByRole('button', { name: '选择文件' })).toBeEnabled()
  await picker.setInputFiles(['queue-a.txt', 'queue-b.txt', 'queue-c.txt', 'queue-remove.txt'].map(file))
  await expect.poll(() => releases.size).toBe(1)
  await expect(task('queue-b.txt')).toContainText('等待上传')
  await expect(task('queue-remove.txt')).toContainText('等待上传')
  await picker.setInputFiles(file('queue-append.txt'))
  await expect(task('queue-append.txt')).toContainText('等待上传')
  expect(prepared).toEqual(['queue-a.txt'])
  await task('queue-remove.txt').getByRole('button', { name: '移除等待项' }).click()
  await expect(task('queue-remove.txt')).toHaveCount(0)
  await page.getByLabel('正文', { exact: true }).fill('queue does not block text')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(page.getByRole('article').filter({ hasText: 'queue does not block text' })).toHaveCount(1)
  for (const [index, name] of ['queue-a.txt', 'queue-b.txt', 'queue-c.txt', 'queue-append.txt'].entries()) {
    await expect.poll(() => releases.size).toBe(index + 1)
    releases.get(name)!()
    await expect(task(name)).toContainText(name === 'queue-b.txt' ? '上传失败' : '上传成功')
  }
  expect(prepared).toEqual(['queue-a.txt', 'queue-b.txt', 'queue-c.txt', 'queue-append.txt'])
  const messages = page.getByRole('article').filter({ hasText: /queue-(a|c|append)\.txt/ })
  await expect(messages).toHaveCount(3)
  await expect(messages.nth(0)).toContainText('queue-a.txt')
  await expect(messages.nth(1)).toContainText('queue-c.txt')
  await expect(messages.nth(2)).toContainText('queue-append.txt')
  await page.unrouteAll({ behavior: 'wait' })
  await page.reload()
  await expect(page.getByRole('button', { name: '选择文件' })).toBeEnabled()
}

export async function verifyQueueRecovery(page: Page) {
  const picker = page.locator('input[type="file"]')
  const task = (name: string) => page.locator('.upload-task').filter({ hasText: name })
  const file = (name: string) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(name) })
  const prepared: string[] = []
  let queries = 0
  let puts = 0
  let retired = 0
  page.on('request', request => {
    if (/\/api\/file-sends\/[^/]+$/.test(new URL(request.url()).pathname) && request.method() === 'GET') queries++
    if (/\/attempts(?:\/[^/]+\/stop)?$/.test(request.url())) retired++
  })
  await page.route('**/api/file-sends', async route => {
    prepared.push(route.request().postDataJSON().send_id)
    await route.continue()
  })
  await page.route('**/api/file-sends/*/attempts/*/content', async route => {
    puts++
    const response = await route.fetch()
    await route.fulfill({ response, status: 502, contentType: 'text/plain', body: 'lost response' })
  }, { times: 1 })
  await picker.setInputFiles(['unknown-first.txt', 'unknown-wait.txt'].map(file))
  await expect(task('unknown-first.txt')).toContainText('结果未确认：')
  await page.context().setOffline(true)
  await page.context().setOffline(false)
  await page.clock.fastForward(30_000)
  await expect(task('unknown-wait.txt')).toContainText('等待上传')
  expect(queries).toBe(0)
  expect(prepared).toHaveLength(1)
  expect(puts).toBe(1)
  await task('unknown-first.txt').getByRole('button', { name: '查询文件结果' }).click()
  await expect(task('unknown-first.txt')).toContainText('上传成功')
  await expect(task('unknown-wait.txt')).toContainText('上传成功')
  expect(queries).toBe(1)

  // 响应已提交但尚未交给页面：本地中断不能谎报撤回，原身份仍可手动确认成功。
  let release!: () => void
  const hold = new Promise<void>(resolve => { release = resolve })
  let arrived = false
  await page.route('**/api/file-sends/*/attempts/*/content', async route => {
    const response = await route.fetch()
    arrived = true
    await hold
    await route.fulfill({ response })
  })
  await picker.setInputFiles([file('interrupt-committed.txt'), file('interrupt-wait.txt')])
  await expect.poll(() => arrived).toBe(true)
  await task('interrupt-committed.txt').getByRole('button', { name: '中断传输' }).click()
  await expect(task('interrupt-committed.txt')).toContainText('结果未确认：')
  await expect(task('interrupt-wait.txt')).toContainText('等待上传')
  release()
  await page.unroute('**/api/file-sends/*/attempts/*/content')
  await task('interrupt-committed.txt').getByRole('button', { name: '查询文件结果' }).click()
  await expect(task('interrupt-committed.txt')).toContainText('上传成功')
  await expect(task('interrupt-wait.txt')).toContainText('上传成功')

  // 准备响应迟到不能触发内容请求；已准备仍属未知，不自动重放 PUT 或解除串行暂停。
  let releasePrepare!: () => void
  const preparedHold = new Promise<void>(resolve => { releasePrepare = resolve })
  let prepareArrived = false
  await page.route('**/api/file-sends', async route => {
    prepared.push(route.request().postDataJSON().send_id)
    const response = await route.fetch()
    prepareArrived = true
    await preparedHold
    await route.fulfill({ response })
  }, { times: 1 })
  await picker.setInputFiles([file('interrupt-prepare.txt'), file('discard-wait.txt')])
  await expect.poll(() => prepareArrived).toBe(true)
  await task('interrupt-prepare.txt').getByRole('button', { name: '中断传输' }).click()
  releasePrepare()
  await task('interrupt-prepare.txt').getByRole('button', { name: '查询文件结果' }).click()
  await expect(task('interrupt-prepare.txt')).toContainText('结果未确认：')
  await expect(task('discard-wait.txt')).toContainText('等待上传')
  const prior = prepared.at(-1)
  let releaseQuery!: () => void
  const queryHold = new Promise<void>(resolve => { releaseQuery = resolve })
  let queryArrived = false
  let queryFinished = false
  await page.route('**/api/file-sends/*', async route => {
    const response = await route.fetch()
    queryArrived = true
    await queryHold
    await route.fulfill({ response })
    queryFinished = true
  }, { times: 1 })
  await task('interrupt-prepare.txt').getByRole('button', { name: '查询文件结果' }).click()
  await expect.poll(() => queryArrived).toBe(true)
  const priorQueries = queries
  page.once('dialog', async dialog => {
    expect(dialog.message()).toContain('重选可能重复')
    expect(dialog.message()).toContain('检查历史')
    await dialog.accept()
  })
  await page.getByRole('button', { name: '结束本轮' }).click()
  await expect(page.locator('.upload-task')).toHaveCount(0)
  await page.clock.fastForward(30_000)
  expect(queries).toBe(priorQueries)
  await picker.setInputFiles(file('interrupt-prepare.txt'))
  await expect(task('interrupt-prepare.txt')).toContainText('上传成功')
  expect(prepared.at(-1)).not.toBe(prior)
  releaseQuery()
  await expect.poll(() => queryFinished).toBe(true)
  await expect(page.locator('.upload-task')).toHaveCount(1)
  await expect(task('interrupt-prepare.txt')).toContainText('上传成功')
  expect(retired).toBe(0)
  await page.unrouteAll({ behavior: 'wait' })
  await page.reload()
  await expect(page.getByRole('button', { name: '选择文件' })).toBeEnabled()
}

export async function verifyFiles(page: Page) {
  await verifyFileQueue(page)
  const picker = page.locator('input[type="file"]')
  // 上传期限来自认证能力快照，不使用固定的 JSON 控制请求期限。
  await page.route('**/api/transfer-limits', async route => {
    const response = await route.fetch()
    await route.fulfill({ response, json: { ...await response.json(), upload_total_timeout_seconds: 2400 } })
  })
  await page.evaluate(() => {
    const original = XMLHttpRequest.prototype.send
    XMLHttpRequest.prototype.send = function (body) {
      if (body instanceof File) document.documentElement.dataset.uploadTimeout = String(this.timeout)
      return original.call(this, body)
    }
  })
  await picker.setInputFiles({ name: 'oversized.txt', mimeType: 'text/plain', buffer: Buffer.alloc(1025) })
  await expect(page.getByText('文件超过服务器单文件上限')).toBeVisible()
  await picker.setInputFiles({ name: 'single-upload.txt', mimeType: 'text/plain', buffer: Buffer.from('single file') })
  await expect(page.locator('.upload-task').filter({ hasText: 'single-upload.txt' })).toContainText('上传成功')
  await expect(page.locator('html')).toHaveAttribute('data-upload-timeout', '2460000')
  await page.unroute('**/api/transfer-limits')
  const otherContext = await page.context().browser()!.newContext({ baseURL: new URL(page.url()).origin })
  const other = await otherContext.newPage()
  await other.goto('/')
  await other.getByLabel('用户名').fill('Admin')
  await other.getByLabel('密码', { exact: true }).fill(' synthetic password ')
  await other.getByRole('button', { name: '登录', exact: true }).click()
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
  await page.unroute('**/api/transfer-limits')
  await page.route('**/api/transfer-limits', async route => {
    const response = await route.fetch()
    const { upload_total_timeout_seconds: omitted, ...limits } = await response.json()
    void omitted
    await route.fulfill({ response, json: limits })
  })
  await page.getByRole('button', { name: '重查文件限制' }).click()
  await expect(page.getByText('限制未知或离线', { exact: false })).toBeVisible()
  await page.unroute('**/api/transfer-limits')
  await page.getByRole('button', { name: '重查文件限制' }).click()
  await expect(page.getByRole('button', { name: '选择文件' })).toBeEnabled()

  const identities: string[] = []
  await page.route('**/api/file-sends', async route => {
    identities.push(route.request().postDataJSON().send_id)
    await route.continue()
  })
  await page.route('**/api/file-sends/*/attempts/*/content', async route => {
    const response = await route.fetch({ postData: 'x' })
    await route.fulfill({ response })
  }, { times: 1 })
  const retry = { name: 'reselected.txt', mimeType: 'text/plain', buffer: Buffer.from('retry') }
  await picker.setInputFiles(retry)
  await expect(page.getByText('上传失败：', { exact: false })).toBeVisible()
  await expect(page.getByRole('button', { name: '同次重试文件' })).toHaveCount(0)
  await picker.setInputFiles(retry)
  await expect(page.getByRole('article').filter({ hasText: retry.name })).toHaveCount(1)
  expect(identities).toHaveLength(2)
  expect(identities[0]).not.toBe(identities[1])
  await page.unrouteAll({ behavior: 'wait' })
  await page.reload()
  await expect(page.getByRole('button', { name: '选择文件' })).toBeEnabled()
}
