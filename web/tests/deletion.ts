import { expect, type Page } from '@playwright/test'
import { readFile, unlink, mkdir, rmdir } from 'node:fs/promises'
import { join } from 'node:path'

export async function verifyDeletion(page: Page) {
  const name = 'delete-local-copy.txt'
  await page.locator('input[type="file"]').setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from('independent local copy') })
  const message = page.getByRole('article').filter({ hasText: name })
  await expect(message.getByRole('link', { name: '下载附件' })).toBeVisible()
  const [download] = await Promise.all([page.waitForEvent('download'), message.getByRole('link', { name: '下载附件' }).click()])
  const localPath = (await download.path())!
  await page.getByLabel('正文', { exact: true }).fill('deletion draft')
  page.once('dialog', async dialog => {
    expect(dialog.message()).toContain(name)
    expect(dialog.message()).toContain('所有设备')
    expect(dialog.message()).toContain('本地副本不受影响')
    expect(dialog.message()).toContain('不可恢复')
    await dialog.accept()
  })
  await message.getByRole('button', { name: '删除服务器文件', exact: true }).click()
  await expect.poll(async () => {
    await page.clock.runFor(2500)
    return await message.textContent()
  }, { timeout: 15000 }).toContain('服务器文件已删除')
  await expect(message.getByRole('link')).toHaveCount(0)
  expect(await readFile(localPath, 'utf8')).toBe('independent local copy')
  await page.getByRole('button', { name: '服务器文件', exact: true }).click()
  await expect(page.getByRole('article').filter({ hasText: name })).toHaveCount(0)
  await page.getByRole('button', { name: '消息工作区' }).click()
  await expect(page.getByLabel('正文', { exact: true })).toHaveValue('deletion draft')
  await page.getByLabel('正文', { exact: true }).fill('')

  // 文件页入口的响应丢失：只查状态，跨页和重新认证均不能隐式重发。
  const unknownName = 'delete-unknown.txt'
  await page.locator('input[type="file"]').setInputFiles({ name: unknownName, mimeType: '', buffer: Buffer.from('unknown') })
  const unknownMessage = page.getByRole('article').filter({ hasText: unknownName })
  await expect(unknownMessage.getByRole('link')).toBeVisible()
  const id = (await unknownMessage.getByRole('link').getAttribute('href'))!.split('/').at(-1)!
  let deletes = 0
  let queries = 0
  await page.route(`**/api/files/${id}`, async route => {
    if (route.request().method() === 'DELETE') { deletes++; await route.abort() }
    else await route.continue()
  })
  await page.route(`**/api/files/${id}/status`, async route => { queries++; await route.continue() })
  await page.getByRole('button', { name: '服务器文件', exact: true }).click()
  const unknownRow = page.getByRole('article').filter({ hasText: unknownName })
  page.once('dialog', dialog => dialog.accept())
  await unknownRow.getByRole('button', { name: '删除服务器文件', exact: true }).click()
  await expect(unknownRow).toContainText('删除结果未确认')
  await page.clock.runFor(5000)
  await expect.poll(() => queries).toBeGreaterThan(0)
  await expect(unknownRow.getByRole('link')).toHaveCount(0)
  await page.getByRole('button', { name: '消息工作区' }).click()
  await expect(unknownMessage).toContainText('删除结果未确认')
  await expect(unknownMessage.getByRole('link')).toHaveCount(0)
  const visibility = async (state: string) => page.evaluate(state => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
    document.dispatchEvent(new Event('visibilitychange'))
  }, state)
  await visibility('hidden')
  const beforeHidden = queries
  await page.clock.runFor(30000)
  expect(queries).toBe(beforeHidden)
  await visibility('visible')
  await expect.poll(() => queries).toBeGreaterThan(beforeHidden)
  await page.evaluate(() => fetch('/api/session', { method: 'DELETE' }))
  await page.getByRole('button', { name: '检查登录状态' }).click()
  await expect(page.getByLabel('用户名')).toBeVisible()
  const beforeLogin = queries
  await page.clock.runFor(30000)
  expect(queries).toBe(beforeLogin)
  await page.getByLabel('用户名').fill('Admin')
  await page.getByLabel('密码', { exact: true }).fill(' synthetic password ')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(unknownMessage).toContainText('删除结果未确认')
  await expect(unknownMessage.getByRole('link')).toHaveCount(0)
  expect(deletes).toBe(1)
  await page.unroute(`**/api/files/${id}`)
  // 真正接受删除后丢弃响应，恢复查询必须得知完成，不需要再次 DELETE。
  await page.route(`**/api/files/${id}`, async route => {
    if (route.request().method() === 'DELETE') {
      deletes++
      await route.fetch()
      await route.abort()
    } else await route.continue()
  })
  page.once('dialog', dialog => dialog.accept())
  await unknownMessage.getByRole('button', { name: '再次确认删除' }).click()
  await expect.poll(async () => {
    await page.clock.runFor(5000)
    return await unknownMessage.textContent()
  }, { timeout: 15000 }).toContain('服务器文件已删除')
  expect(deletes).toBe(2)
  await page.unrouteAll({ behavior: 'wait' })
  await verifyCleanupAndOrdering(page)
  await verifyRejectedDeletion(page)
}

// 活动读取竞争的真实后端证据在 files.rs；这里仅注入冲突响应及其丢失，验证浏览器绝不排队重发。
async function verifyRejectedDeletion(page: Page) {
  const name = 'delete-in-use.txt'
  await page.locator('input[type="file"]').setInputFiles({ name, mimeType: '', buffer: Buffer.from('busy') })
  const row = page.getByRole('article').filter({ hasText: name })
  await expect(row.getByRole('link')).toBeVisible()
  const id = (await row.getByRole('link').getAttribute('href'))!.split('/').at(-1)!
  let deletes = 0
  let lose = false
  await page.route(`**/api/files/${id}`, async route => {
    if (route.request().method() !== 'DELETE') { await route.continue(); return }
    deletes++
    if (lose) await route.abort()
    else await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ code: 'FILE_IN_USE', message: 'File in use' }) })
  })
  page.once('dialog', dialog => dialog.accept())
  await row.getByRole('button', { name: '删除服务器文件', exact: true }).click()
  await expect(row).toContainText('本次删除已结束')
  await expect(row.getByRole('link')).toBeVisible()
  await page.clock.runFor(10000)
  expect(deletes).toBe(1)
  lose = true
  page.once('dialog', dialog => dialog.accept())
  await row.getByRole('button', { name: '删除服务器文件', exact: true }).click()
  await expect(row).toContainText('删除结果未确认')
  await page.clock.runFor(10000)
  await expect(row.getByRole('link')).toHaveCount(0)
  expect(deletes).toBe(2)
  expect((await (await page.request.get(`/api/files/${id}/status`)).json()).file_state).toBe('available')
  await page.unrouteAll({ behavior: 'wait' })
  // 主动退出清除未确认上下文，不能把旧查询的回调带到下一个认证周期。
}

async function verifyCleanupAndOrdering(page: Page) {
  const name = 'delete-cleanup.txt'
  await page.locator('input[type="file"]').setInputFiles({ name, mimeType: '', buffer: Buffer.from('cleanup') })
  const message = page.getByRole('article').filter({ hasText: name })
  await expect(message.getByRole('link')).toBeVisible()
  const id = (await message.getByRole('link').getAttribute('href'))!.split('/').at(-1)!
  const context = await page.context().browser()!.newContext()
  const other = await context.newPage()
  await other.goto(page.url())
  await other.getByLabel('用户名').fill('Admin')
  await other.getByLabel('密码', { exact: true }).fill(' synthetic password ')
  await other.getByRole('button', { name: '登录', exact: true }).click()
  const otherMessage = other.getByRole('article').filter({ hasText: name })
  await expect(otherMessage.getByRole('link')).toBeVisible()

  // 仅对本次隔离 fixture 的合成实体制造清理失败，不改生产目录或引入调试接口。
  const root = process.env.TEST_FILES!
  expect(root).toMatch(/^\/tmp\/filehop-browser-[^/]+\/files$/)
  expect(id).toMatch(/^[0-9a-f-]{36}$/)
  const entity = join(root, id)
  await unlink(entity)
  await mkdir(entity)
  await page.getByRole('button', { name: '服务器文件', exact: true }).click()
  const usage = page.getByRole('region', { name: '应用文件额度', exact: true })
  await expect(usage).toContainText('待清理占用：0 字节')
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
  await page.getByRole('button', { name: '刷新文件列表' }).click()
  await received
  const row = page.getByRole('article').filter({ hasText: name })
  page.once('dialog', dialog => dialog.accept())
  await row.getByRole('button', { name: '删除服务器文件', exact: true }).click()
  await expect(row).toContainText('删除处理中，空间尚未释放')
  await expect(usage).toContainText('待清理占用：7 字节')
  // 清理占用与并发上传完整预留必须互斥；仍由真实准备接口决定能否准入。
  const attempt = await page.evaluate(async () => {
    const send = crypto.randomUUID(), attempt = crypto.randomUUID()
    const response = await fetch('/api/file-sends', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ send_id: send, attempt_id: attempt, name: 'concurrent.txt', size: 3, mime: '', source_label: 'Web' }) })
    if (!response.ok) throw Error('prepare failed')
    return { send, attempt }
  })
  // 列表旧响应仍被屏障拦住；容量由下一次删除状态查询独立更新。
  await expect.poll(async () => {
    await page.clock.runFor(2500)
    return await usage.textContent()
  }).toContain('上传预留：3 字节')
  await expect(usage).toContainText('待清理占用：7 字节')
  await page.evaluate(async ({ send, attempt }) => {
    const response = await fetch(`/api/file-sends/${send}/attempts/${attempt}/content`, { method: 'PUT', body: 'abc' })
    if (!response.ok) throw Error('upload failed')
  }, attempt)
  await expect(row.getByRole('link')).toHaveCount(0)
  await page.clock.runFor(3000)
  await expect(row).toContainText('删除处理中，空间尚未释放')
  await rmdir(entity)
  await expect.poll(async () => {
    await page.clock.runFor(2500)
    return await row.count()
  }, { timeout: 20000 }).toBe(0)
  await expect(usage).toContainText('待清理占用：0 字节')
  release()
  await expect(page.getByRole('button', { name: '刷新文件列表' })).toBeEnabled()
  await expect(row).toHaveCount(0)
  await page.getByRole('button', { name: '消息工作区' }).click()
  await expect(message).toContainText('服务器文件已删除')
  // 独立浏览器没有实时推送保证；手动刷新校正已加载的旧记录。
  await other.getByRole('button', { name: '读取最近消息' }).click()
  await expect(otherMessage).toContainText('服务器文件已删除')
  await expect(otherMessage.getByRole('link')).toHaveCount(0)
  await context.close()
  await page.unrouteAll({ behavior: 'wait' })
}
