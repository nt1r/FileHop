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
  await expect(page.getByText(/等待文件需重新选择/)).toBeVisible()
  await expect(page.locator('.upload-task')).toHaveCount(0)
  await page.getByLabel('用户名').fill('Admin')
  await page.getByLabel('密码', { exact: true }).fill(' synthetic password ')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByRole('button', { name: '选择文件' })).toBeEnabled()
  release()
  await expect(task('session-active.txt')).toContainText('结果未确认：')
  await page.clock.fastForward(30_000)
  expect(queries).toHaveLength(0)
  expect(prepared).toHaveLength(1)
  await expect(task('session-wait.txt')).toHaveCount(0)
  await task('session-active.txt').getByRole('button', { name: '查询文件结果' }).click()
  await expect(task('session-active.txt')).toContainText('上传成功')
  await page.clock.fastForward(30_000)
  await expect(task('session-wait.txt')).toHaveCount(0)
  expect(prepared).toHaveLength(1)
  expect(queries).toEqual([`/api/file-sends/${prepared[0]}`])
  expect(retired).toHaveLength(0)
  await expect(page.getByLabel('正文', { exact: true })).toHaveValue('session draft stays unsent')
  await expect(page.getByRole('article').filter({ hasText: 'session draft stays unsent' })).toHaveCount(0)
  await page.unrouteAll({ behavior: 'wait' })

  // 准备已被服务器接受但响应未到时失效：重登也不能让迟到准备继续发文件体。
  let releasePrepare!: () => void
  const heldPrepare = new Promise<void>(resolve => { releasePrepare = resolve })
  let prepareArrived = false
  let oldSend = ''
  const contents: string[] = []
  page.on('request', request => {
    if (request.method() === 'PUT' && request.url().endsWith('/content')) contents.push(request.url())
  })
  await page.route('**/api/file-sends', async route => {
    oldSend = route.request().postDataJSON().send_id
    const response = await route.fetch()
    prepareArrived = true
    await heldPrepare
    await route.fulfill({ response })
  }, { times: 1 })
  await page.locator('input[type="file"]').setInputFiles(['expired-prepare.txt', 'discard-wait.txt'].map(name => ({ name, mimeType: 'text/plain', buffer: Buffer.alloc(0) })))
  await expect.poll(() => prepareArrived).toBe(true)
  await page.evaluate(() => fetch('/api/session', { method: 'DELETE' }))
  await page.getByRole('button', { name: '检查登录状态' }).click()
  await expect(page.getByText(/等待文件需重新选择/)).toBeVisible()
  await expect(page.locator('.upload-task')).toHaveCount(0)
  await page.getByLabel('用户名').fill('Admin')
  await page.getByLabel('密码', { exact: true }).fill(' synthetic password ')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByRole('button', { name: '选择文件' })).toBeEnabled()
  releasePrepare()
  await page.unrouteAll({ behavior: 'wait' })
  await expect(task('expired-prepare.txt')).toContainText('结果未确认：')
  await expect(task('discard-wait.txt')).toHaveCount(0)
  expect(contents).toHaveLength(0)
  expect(queries).toHaveLength(1)

  // 结束本轮后才交还旧查询；即使下一批已成功，旧身份也不能回到任务列表。
  let releaseQuery!: () => void
  const heldQuery = new Promise<void>(resolve => { releaseQuery = resolve })
  let queryArrived = false
  await page.route(`**/api/file-sends/${oldSend}`, async route => {
    const response = await route.fetch()
    queryArrived = true
    await heldQuery
    await route.fulfill({ response })
  }, { times: 1 })
  await task('expired-prepare.txt').getByRole('button', { name: '查询文件结果' }).click()
  await expect.poll(() => queryArrived).toBe(true)
  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: '结束本轮', exact: true }).click()
  await page.locator('input[type="file"]').setInputFiles({ name: 'new-session-batch.txt', mimeType: 'text/plain', buffer: Buffer.from('new batch') })
  await expect(task('new-session-batch.txt')).toContainText('上传成功')
  releaseQuery()
  await page.unrouteAll({ behavior: 'wait' })
  await expect(page.locator('.upload-task')).toHaveCount(1)
  await expect(task('new-session-batch.txt')).toContainText('上传成功')
  expect(contents).toHaveLength(1)
  expect(contents[0]).not.toContain(oldSend)
  await page.clock.fastForward(43_200_000)
  await page.getByLabel('用户名').fill('Admin')
  await page.getByLabel('密码', { exact: true }).fill(' synthetic password ')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByRole('button', { name: '选择文件' })).toBeEnabled()
  await expect(page.locator('.upload-task')).toHaveCount(0)
  expect(queries).toHaveLength(2)
  expect(retired).toHaveLength(0)
  await page.getByLabel('正文', { exact: true }).fill('')
  await page.reload()
  await expect(page.getByRole('button', { name: '选择文件' })).toBeEnabled()
}
