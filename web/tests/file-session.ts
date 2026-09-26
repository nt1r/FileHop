import { expect, type Page } from '@playwright/test'

export async function verifyFileSession(page: Page) {
  const task = (name: string) => page.locator('.upload-task').filter({ hasText: name })
  const prepared: string[] = []
  const releases = new Map<string, () => void>()
  await page.route('**/api/file-sends', async route => {
    prepared.push(route.request().postDataJSON().name)
    await route.continue()
  })
  await page.route('**/api/file-sends/*/attempts/*/content', async route => {
    const name = route.request().postData()!
    const response = await route.fetch(name === 'session-failed.txt' ? { postData: 'x' } : {})
    await new Promise<void>(resolve => { releases.set(name, resolve) })
    await route.fulfill({ response })
  })
  const names = ['session-failed.txt', 'session-a.txt', 'session-b.txt', 'session-c.txt', 'session-wait.txt']
  await expect(page.getByRole('button', { name: '选择文件' })).toBeEnabled()
  await page.locator('input[type="file"]').setInputFiles(names.map(name => ({ name, mimeType: 'text/plain', buffer: Buffer.from(name) })))
  await expect.poll(() => releases.size).toBe(3)
  releases.get(names[0])!()
  await expect(task(names[0])).toContainText('上传失败')
  await expect.poll(() => releases.size).toBe(4)
  await page.getByLabel('正文', { exact: true }).fill('session draft stays unsent')
  await page.clock.fastForward(43_200_000)
  await expect(page.getByRole('region', { name: '消息流' })).toHaveCount(0)
  await expect(page.getByText(/session-.*\.txt/)).toHaveCount(0)

  // 恢复时限制响应暂不可达：旧队列不能靠旧上限继续，也不能先发恢复查询。
  let releaseLimits!: () => void
  const holdLimits = new Promise<void>(resolve => { releaseLimits = resolve })
  let limitsArrived = false
  const queries: string[] = []
  let releaseQuery!: () => void
  const holdQuery = new Promise<void>(resolve => { releaseQuery = resolve })
  await page.route('**/api/transfer-limits', async route => {
    const response = await route.fetch()
    limitsArrived = true
    await holdLimits
    await route.fulfill({ response })
  })
  await page.route('**/api/file-sends/*', async route => {
    if (route.request().method() !== 'GET') { await route.continue(); return }
    queries.push(route.request().url())
    const response = await route.fetch()
    await holdQuery
    await route.fulfill({ response })
  })
  await page.getByLabel('用户名').fill('Admin')
  await page.getByLabel('密码', { exact: true }).fill(' synthetic password ')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect.poll(() => limitsArrived).toBe(true)
  await expect(task(names[4])).toContainText('等待上传')
  expect(queries).toHaveLength(0)
  expect(prepared).toEqual(names.slice(0, 4))
  releaseLimits()
  await expect.poll(() => queries.length).toBe(3)
  await expect(task(names[4])).toContainText('等待上传')
  expect(prepared).toEqual(names.slice(0, 4))
  releaseQuery()
  await expect(task(names[1])).toContainText('上传成功')
  await expect(task(names[2])).toContainText('上传成功')
  await expect(task(names[3])).toContainText('上传成功')
  await expect.poll(() => releases.size).toBe(5)
  expect(prepared).toEqual(names)
  await expect(task(names[0])).toContainText('上传失败')
  await expect(page.getByLabel('正文', { exact: true })).toHaveValue('session draft stays unsent')
  await expect(page.getByRole('article').filter({ hasText: 'session draft stays unsent' })).toHaveCount(0)
  for (const name of names.slice(1)) releases.get(name)!()
  await expect(task(names[4])).toContainText('上传成功')
  await page.unrouteAll({ behavior: 'wait' })
  await page.getByLabel('正文', { exact: true }).fill('')
  await page.reload()
  await expect(page.locator('.upload-task')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '选择文件' })).toBeEnabled()
  await verifyActiveReconciliation(page)
}

async function verifyActiveReconciliation(page: Page) {
  const task = (name: string) => page.locator('.upload-task').filter({ hasText: name })
  const file = (name: string) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(name) })
  // 先准备但丢失文件体，查询得到“仍活动”：新认证周期不能沿用这份旧判断。
  await page.route('**/api/file-sends/*/attempts/*/content', route => route.abort(), { times: 1 })
  await page.locator('input[type="file"]').setInputFiles(file('reconcile-active.txt'))
  await expect(task('reconcile-active.txt')).toContainText('结果未确认：')
  await task('reconcile-active.txt').getByRole('button', { name: '查询文件结果' }).click()
  await expect(task('reconcile-active.txt')).toContainText('服务器仍在接收或处理')
  await page.context().setOffline(true)
  await page.clock.fastForward(43_200_000)
  await expect(page.getByRole('region', { name: '消息流' })).toHaveCount(0)
  await page.context().setOffline(false)
  let release!: () => void
  const hold = new Promise<void>(resolve => { release = resolve })
  let queried = false
  await page.route('**/api/file-sends/*', async route => {
    const response = await route.fetch()
    queried = true
    await hold
    await route.fulfill({ response })
  })
  await page.getByLabel('用户名').fill('Admin')
  await page.getByLabel('密码', { exact: true }).fill(' synthetic password ')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect.poll(() => queried).toBe(true)
  await expect(page.getByRole('button', { name: '选择文件' })).toBeEnabled()
  await page.locator('input[type="file"]').setInputFiles(file('reconcile-wait.txt'))
  await expect(task('reconcile-wait.txt')).toContainText('等待上传')
  release()
  await page.unrouteAll({ behavior: 'wait' })
  await expect(task('reconcile-wait.txt')).toContainText('上传成功')
  await task('reconcile-active.txt').getByRole('button', { name: '停止上传' }).click()
  await expect(task('reconcile-active.txt')).toContainText('已停止')
  await page.reload()
  await expect(page.getByRole('button', { name: '选择文件' })).toBeEnabled()
}
