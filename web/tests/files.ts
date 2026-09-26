import { expect, type Page } from '@playwright/test'

async function verifyFileQueue(page: Page) {
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
  await expect.poll(() => releases.size).toBe(3)
  await expect(task('queue-remove.txt')).toContainText('等待上传')
  await picker.setInputFiles(file('queue-append.txt'))
  await expect(task('queue-append.txt')).toContainText('等待上传')
  expect(prepared).toEqual(['queue-a.txt', 'queue-b.txt', 'queue-c.txt'])
  await task('queue-remove.txt').getByRole('button', { name: '移除等待项' }).click()
  await expect(task('queue-remove.txt')).toHaveCount(0)
  await page.getByLabel('正文', { exact: true }).fill('queue does not block text')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(page.getByRole('article').filter({ hasText: 'queue does not block text' })).toHaveCount(1)
  releases.get('queue-b.txt')!()
  await expect(task('queue-b.txt')).toContainText('上传失败')
  await expect.poll(() => releases.size).toBe(4)
  expect(prepared).toEqual(['queue-a.txt', 'queue-b.txt', 'queue-c.txt', 'queue-append.txt'])
  for (const name of ['queue-c.txt', 'queue-append.txt', 'queue-a.txt']) {
    releases.get(name)!()
    await expect(task(name)).toContainText('上传成功')
  }
  const messages = page.getByRole('article').filter({ hasText: /queue-(a|c|append)\.txt/ })
  await expect(messages).toHaveCount(3)
  await expect(messages.nth(0)).toContainText('queue-c.txt')
  await expect(messages.nth(1)).toContainText('queue-append.txt')
  await expect(messages.nth(2)).toContainText('queue-a.txt')
  await page.unrouteAll({ behavior: 'wait' })
  await page.reload()
  await expect(page.getByRole('button', { name: '选择文件' })).toBeEnabled()
}

async function verifyQueueRecovery(page: Page) {
  const picker = page.locator('input[type="file"]')
  const task = (name: string) => page.locator('.upload-task').filter({ hasText: name })
  const names = ['recovery-a.txt', 'recovery-b.txt', 'recovery-c.txt', 'recovery-wait.txt']
  const releases = new Map<string, () => void>()
  const prepared: string[] = []
  await page.route('**/api/file-sends', async route => {
    prepared.push(route.request().postDataJSON().name)
    await route.continue()
  })
  await page.route('**/api/file-sends/*/attempts/*/content', async route => {
    const name = route.request().postData()!
    const response = await route.fetch()
    await new Promise<void>(resolve => { releases.set(name, resolve) })
    await route.fulfill({ response, ...(name === names[0] ? { status: 502, contentType: 'text/plain', body: 'lost' } : {}) })
  })
  await picker.setInputFiles(names.map(name => ({ name, mimeType: 'text/plain', buffer: Buffer.from(name) })))
  await expect.poll(() => releases.size).toBe(3)
  await page.context().setOffline(true)
  releases.get(names[0])!()
  await expect(task(names[0])).toContainText('结果未确认：')
  page.once('dialog', dialog => dialog.accept())
  await task(names[0]).getByRole('button', { name: '放弃确认' }).click()
  await expect(page.getByText('仍有 1 项结果待确认：', { exact: false })).toBeVisible()
  // 即使另一个任务已经成功并释放名额，未知项仍必须先协调，放弃不能绕过暂停。
  releases.get(names[1])!()
  await expect(task(names[1])).toContainText('上传成功')
  await expect(task(names[3])).toContainText('等待上传')
  let releaseQuery!: () => void
  const hold = new Promise<void>(resolve => { releaseQuery = resolve })
  let queried = false
  await page.route('**/api/file-sends/*', async route => {
    if (route.request().method() !== 'GET') { await route.continue(); return }
    const response = await route.fetch()
    queried = true
    await hold
    await route.fulfill({ response })
  })
  await page.context().setOffline(false)
  await expect.poll(() => queried).toBe(true)
  await expect(task(names[3])).toContainText('等待上传')
  expect(prepared).toEqual(names.slice(0, 3))
  releaseQuery()
  await expect(task(names[0])).toContainText('上传成功')
  await expect.poll(() => releases.size).toBe(4)
  // 停止 C 只取消它的本页请求；已提交则返回成功，不干扰仍在等待响应的第四项。
  await task(names[2]).getByRole('button', { name: '停止上传' }).click()
  await expect(task(names[2])).toContainText('上传成功')
  releases.get(names[2])!()
  releases.get(names[3])!()
  await expect(task(names[3])).toContainText('上传成功')
  await page.unrouteAll({ behavior: 'wait' })
  await page.reload()
  await expect(page.getByRole('button', { name: '选择文件' })).toBeEnabled()
}

export async function verifyFiles(page: Page) {
  const picker = page.locator('input[type="file"]')
  await verifyFileQueue(page)
  await verifyQueueRecovery(page)
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
  await expect(page.getByText('暂停新上传：', { exact: false })).toBeVisible()
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

  // 停止未提交的慢传输后，浏览器不得凭 abort 报告已停止；服务端确认后才能释放页面任务。
  let resumeStop!: () => void
  let uploadedStop!: () => void
  const stopHold = new Promise<void>(resolve => { resumeStop = resolve })
  const stopArrived = new Promise<void>(resolve => { uploadedStop = resolve })
  await page.route('**/api/file-sends/*/attempts/*/content', async route => {
    uploadedStop()
    await stopHold
    await route.continue().catch(() => {})
  })
  await picker.setInputFiles({ name: 'stop-file.txt', mimeType: 'text/plain', buffer: Buffer.from('stop') })
  await stopArrived
  await page.getByRole('button', { name: '停止上传' }).last().click()
  await expect(page.getByText('已停止；', { exact: false })).toBeVisible()
  resumeStop()
  await page.unrouteAll({ behavior: 'wait' })
  await expect(page.getByRole('article').filter({ hasText: 'stop-file.txt' })).toHaveCount(0)

  // 停止响应丢失后仍显示未知；放弃只隐藏动作，不隐藏未确认名额与原因。
  await page.route('**/api/file-sends/*/attempts/*/stop', async route => {
    const response = await route.fetch()
    await route.fulfill({ response, status: 502, contentType: 'text/plain', body: 'lost' })
  }, { times: 1 })
  await page.route('**/api/file-sends/*/attempts/*/content', route => route.abort(), { times: 1 })
  await picker.setInputFiles({ name: 'abandoned-file.txt', mimeType: 'text/plain', buffer: Buffer.from('abandon') })
  await expect(page.getByText('结果未确认：', { exact: false })).toBeVisible()
  await page.getByRole('button', { name: '停止上传' }).last().click()
  await expect(page.getByRole('button', { name: '放弃确认' }).last()).toBeVisible()
  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: '放弃确认' }).last().click()
  await expect(page.getByText('仍有 1 项结果待确认：', { exact: false })).toBeVisible()
  await expect(page.getByText('暂停新上传：', { exact: false })).toBeVisible()
  await page.getByRole('button', { name: '查询文件结果' }).last().click()
  // 若服务器已清理则查询会释放占用；若仍在清理则继续显示等待原因。
  await page.unrouteAll({ behavior: 'wait' })
  await page.reload()
  await expect(page.getByRole('button', { name: '选择文件' })).toBeEnabled()

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
  await picker.setInputFiles(['late-file.txt', 'late-second.txt', 'late-third.txt', 'late-waiting.txt'].map(name => ({ name, mimeType: 'text/plain', buffer: Buffer.from('late') })))
  await received
  await expect(page.locator('.upload-task').filter({ hasText: 'late-waiting.txt' })).toContainText('等待上传')
  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: '退出登录' }).click()
  await expect(page.getByRole('region', { name: '消息流' })).toHaveCount(0)
  release()
  await page.unrouteAll({ behavior: 'wait' })
  await expect(page.getByText(/late-(file|second|third|waiting)\.txt/)).toHaveCount(0)
  await page.getByLabel('用户名').fill('Admin')
  await page.getByLabel('密码', { exact: true }).fill(' synthetic password ')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByRole('article').filter({ hasText: 'late-file.txt' })).toHaveCount(1)
  await expect(page.getByText('late-waiting.txt', { exact: false })).toHaveCount(0)

  let releaseExpiry!: () => void
  let expiryCount = 0
  let arrivedExpiry!: () => void
  const expiryHold = new Promise<void>(resolve => { releaseExpiry = resolve })
  const expiryReceived = new Promise<void>(resolve => { arrivedExpiry = resolve })
  await page.route('**/api/file-sends/*/attempts/*/content', async route => {
    const response = await route.fetch()
    if (++expiryCount === 3) arrivedExpiry()
    await expiryHold
    await route.fulfill({ response })
  })
  await expect(page.getByRole('button', { name: '选择文件' })).toBeEnabled()
  await picker.setInputFiles(['expired-file.txt', 'expired-second.txt', 'expired-third.txt', 'expired-waiting.txt'].map(name => ({ name, mimeType: 'text/plain', buffer: Buffer.from('expired') })))
  await expiryReceived
  await expect(page.locator('.upload-task').filter({ hasText: 'expired-waiting.txt' })).toContainText('等待上传')
  await page.clock.fastForward(43_200_000)
  await expect(page.getByRole('region', { name: '消息流' })).toHaveCount(0)
  releaseExpiry()
  await page.unrouteAll({ behavior: 'wait' })
  await expect(page.getByText(/expired-(file|second|third|waiting)\.txt/)).toHaveCount(0)
  await page.getByLabel('用户名').fill('Admin')
  await page.getByLabel('密码', { exact: true }).fill(' synthetic password ')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.locator('.upload-task').filter({ hasText: 'expired-waiting.txt' })).toContainText('上传成功')
  await expect(page.getByRole('button', { name: '选择文件' })).toBeEnabled()
  page.once('dialog', dialog => dialog.accept())
  await page.reload()
  await expect(page.getByRole('region', { name: '消息流' })).toBeVisible()
}
