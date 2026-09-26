import { expect, type Page } from '@playwright/test'
import { unlinkSync } from 'node:fs'
import { join } from 'node:path'

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
  const usage = listing.getByRole('region', { name: '应用文件额度', exact: true })
  await expect(usage).toContainText('总额度：1,073,741,824 字节')
  await expect(usage).toContainText('上传预留：48 字节')
  await expect(listing.getByText(names[0], { exact: false })).toHaveCount(0)
  releases.get(names[0])!()
  // 切页不能停止等待项接续；第四个请求在文件页仍会开始。
  await expect.poll(() => releases.size).toBe(4)
  for (const name of names.slice(1)) releases.get(name)!()
  await expect.poll(() => completed).toBe(4)
  await page.unrouteAll({ behavior: 'wait' })
  await listing.getByRole('button', { name: '刷新文件列表' }).click()
  await expect(usage).toContainText('上传预留：0 字节')
  await expect(usage).toContainText('不是整台服务器磁盘用量')
  const row = listing.getByRole('article').filter({ hasText: names[0] })
  await expect(row).toContainText('可用')
  const [download] = await Promise.all([page.waitForEvent('download'), row.getByRole('link', { name: '下载附件' }).click()])
  expect(download.suggestedFilename()).toBe(names[0])
  expect(await download.failure()).toBeNull()
  // 下载打开才发现实体丢失；状态查询必须把两个视图一起校正，且保留草稿和队列。
  const fileId = (await row.getByRole('link', { name: '下载附件' }).getAttribute('href'))!.split('/').at(-1)!
  // 保留真实旧列表响应；较新状态已被确认后才放行，不能恢复可下载。
  let releaseOldList!: () => void
  let oldListArrived!: () => void
  const heldOldList = new Promise<void>(resolve => { releaseOldList = resolve })
  const gotOldList = new Promise<void>(resolve => { oldListArrived = resolve })
  await page.route('**/api/files', async route => {
    const response = await route.fetch()
    oldListArrived()
    await heldOldList
    await route.fulfill({ response })
  }, { times: 1 })
  await listing.getByRole('button', { name: '刷新文件列表' }).click()
  await gotOldList
  unlinkSync(join(process.env.TEST_FILES!, fileId))
  await row.getByRole('link', { name: '下载附件' }).click()
  await expect(row).toContainText('存储异常')
  await expect(row.getByRole('link', { name: '下载附件' })).toHaveCount(0)
  const oldListResponse = page.waitForResponse('**/api/files')
  releaseOldList()
  await oldListResponse
  await expect(listing.getByRole('button', { name: '刷新文件列表' })).toBeEnabled()
  await expect(row).toContainText('存储异常')
  await expect(row.getByRole('link', { name: '下载附件' })).toHaveCount(0)
  // 延迟真实旧快照，期间提交新文件并刷新；旧响应不能覆盖较新的容量。
  let releaseUsage!: () => void
  let receivedUsage!: (saved: string) => void
  const heldUsage = new Promise<void>(resolve => { releaseUsage = resolve })
  const oldSaved = new Promise<string>(resolve => { receivedUsage = resolve })
  await page.route('**/api/storage', async route => {
    const response = await route.fetch()
    receivedUsage((await response.json()).saved_bytes)
    await heldUsage
    await route.fulfill({ response })
  }, { times: 1 })
  await listing.getByRole('button', { name: '刷新文件列表' }).click()
  const saved = BigInt(await oldSaved)
  await page.evaluate(async () => {
    const send = crypto.randomUUID(), attempt = crypto.randomUUID()
    const prepared = await fetch('/api/file-sends', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ send_id: send, attempt_id: attempt, name: 'usage-order.txt', size: 3, mime: '', source_label: 'Web' }) })
    if (!prepared.ok) throw Error('prepare failed')
    const uploaded = await fetch(`/api/file-sends/${send}/attempts/${attempt}/content`, { method: 'PUT', body: 'abc' })
    if (!uploaded.ok) throw Error('upload failed')
  })
  await listing.getByRole('button', { name: '刷新文件列表' }).click()
  const expectedSaved = `已保存文件：${(saved + 3n).toLocaleString('zh-CN')} 字节`
  await expect(usage).toContainText(expectedSaved)
  const lateUsage = page.waitForResponse('**/api/storage')
  releaseUsage()
  await lateUsage
  await expect(usage).toContainText(expectedSaved)
  await page.unrouteAll({ behavior: 'wait' })
  // 撤销真实会话后，用量读取触发认证失效；重新认证仍在文件页取得新快照。
  await page.evaluate(() => fetch('/api/session', { method: 'DELETE' }))
  await listing.getByRole('button', { name: '刷新文件列表' }).click()
  await expect(usage).toHaveCount(0)
  await page.getByLabel('用户名').fill('Admin')
  await page.getByLabel('密码', { exact: true }).fill(' synthetic password ')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(usage).toContainText(expectedSaved)
  await page.getByRole('button', { name: '消息工作区' }).click()
  await expect(page.getByRole('article').filter({ hasText: names[0] })).toContainText('存储异常')
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

  // 已加载的旧文件不一定出现在新增轮询里；手动刷新须单独校正而不丢消息顺序。
  const visibility = async (state: 'hidden' | 'visible') => page.evaluate(state => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
    document.dispatchEvent(new Event('visibilitychange'))
  }, state)
  await visibility('hidden')
  let hiddenQueries = 0
  await page.route('**/api/files/status-query', async route => { hiddenQueries++; await route.continue() })
  await page.getByRole('button', { name: '读取最近消息' }).click()
  await page.clock.runFor(30000)
  expect(hiddenQueries).toBe(0)
  await visibility('visible')
  await expect.poll(() => hiddenQueries).toBeGreaterThan(0)
  await page.unroute('**/api/files/status-query')
  const otherRow = page.getByRole('article').filter({ hasText: names[1] })
  const otherId = (await otherRow.getByRole('link', { name: '下载附件' }).getAttribute('href'))!.split('/').at(-1)!
  const order = await page.locator('[data-message-id]').evaluateAll(nodes => nodes.map(n => n.getAttribute('data-message-id')))
  unlinkSync(join(process.env.TEST_FILES!, otherId))
  await page.request.get(`/api/files/${otherId}`)
  await page.getByLabel('正文', { exact: true }).fill('status correction draft')
  await page.getByRole('button', { name: '读取最近消息' }).click()
  await expect(otherRow).toContainText('存储异常')
  expect(await page.locator('[data-message-id]').evaluateAll(nodes => nodes.map(n => n.getAttribute('data-message-id')))).toEqual(order)
  await expect(page.getByLabel('正文', { exact: true })).toHaveValue('status correction draft')
  await page.getByLabel('正文', { exact: true }).fill('')

  // 真实批量状态响应延迟到退出并重新登录后，不能恢复旧认证周期内容。
  let releaseStatus!: () => void
  let statusArrived!: () => void
  const heldStatus = new Promise<void>(resolve => { releaseStatus = resolve })
  const gotStatus = new Promise<void>(resolve => { statusArrived = resolve })
  await page.route('**/api/files/status-query', async route => {
    const response = await route.fetch()
    statusArrived()
    await heldStatus
    await route.fulfill({ response })
  }, { times: 1 })
  await page.getByRole('button', { name: '读取最近消息' }).click()
  await gotStatus
  // 真实读取响应延迟到退出并重新登录后，不能恢复旧认证周期的文件列表。
  let release!: () => void
  let arrived!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const received = new Promise<void>(resolve => { arrived = resolve })
  let storageArrived!: () => void
  const storageReceived = new Promise<void>(resolve => { storageArrived = resolve })
  await page.route('**/api/storage', async route => {
    const response = await route.fetch()
    storageArrived()
    await held
    await route.fulfill({ response })
  }, { times: 1 })
  await page.route('**/api/files', async route => {
    const response = await route.fetch()
    arrived()
    await held
    await route.fulfill({ response })
  }, { times: 1 })
  await page.getByRole('button', { name: '服务器文件', exact: true }).click()
  await Promise.all([received, storageReceived])
  await page.getByRole('button', { name: '退出登录' }).click()
  await expect(listing).toHaveCount(0)
  await page.getByLabel('用户名').fill('Admin')
  await page.getByLabel('密码', { exact: true }).fill(' synthetic password ')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByRole('region', { name: '消息流' })).toBeVisible()
  const response = Promise.all([page.waitForResponse('**/api/files'), page.waitForResponse('**/api/storage')])
  release()
  releaseStatus()
  await response
  await expect(listing).toHaveCount(0)
  await page.unrouteAll({ behavior: 'wait' })
}
