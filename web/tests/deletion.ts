import { expect, type Page } from '@playwright/test'
import { readFile, unlink, mkdir, rmdir } from 'node:fs/promises'
import { join } from 'node:path'

const filesPage = (page: Page) => page.getByRole('link', { name: '服务器文件', exact: true }).click()
const messagesPage = (page: Page) => page.getByRole('link', { name: '消息工作区' }).click()
const row = (page: Page, name: string) => page.getByRole('article').filter({ hasText: name })
const refresh = (page: Page) => page.getByRole('button', { name: '刷新文件列表' }).click()
async function deleted(page: Page, id: string) {
  // 只由测试探针等待真实清理；不替浏览器触发查询或修改其状态。
  await expect.poll(async () => (await (await page.request.get(`/api/files/${id}/status`)).json()).file_state, { timeout: 20000 }).toBe('deleted')
}

export async function verifyDeletion(page: Page) {
  const name = 'delete-local-copy.txt'
  await page.locator('input[type="file"]').setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from('independent local copy') })
  const message = row(page, name)
  await expect(message.getByRole('link')).toBeVisible()
  await expect(message.getByRole('button', { name: '删除服务器文件' })).toHaveCount(0)
  const [download] = await Promise.all([page.waitForEvent('download'), message.getByRole('link').click()])
  const localPath = (await download.path())!
  const id = (await message.getByRole('link').getAttribute('href'))!.split('/').at(-1)!
  await page.getByLabel('正文', { exact: true }).fill('deletion draft')
  await filesPage(page)
  page.once('dialog', async dialog => {
    for (const text of [name, '所有设备', '本地副本不受影响', '不可恢复']) expect(dialog.message()).toContain(text)
    await dialog.accept()
  })
  await message.getByRole('button', { name: '删除服务器文件', exact: true }).click()
  await expect(message).toContainText('删除处理中，空间尚未释放')
  await deleted(page, id)
  await refresh(page)
  await expect(message).toHaveCount(0)
  expect(await readFile(localPath, 'utf8')).toBe('independent local copy')
  await messagesPage(page)
  await expect(message).toContainText('服务器文件已删除')
  await expect(page.getByLabel('正文', { exact: true })).toHaveValue('deletion draft')
  await page.getByLabel('正文', { exact: true }).fill('')

  await verifyUnknownDeletion(page)
  await verifyCleanup(page)
  await verifyRejectedDeletion(page)
}

async function verifyUnknownDeletion(page: Page) {
  const name = 'delete-unknown.txt'
  await page.locator('input[type="file"]').setInputFiles({ name, mimeType: '', buffer: Buffer.from('unknown') })
  const item = row(page, name)
  await expect(item.getByRole('link')).toBeVisible()
  const id = (await item.getByRole('link').getAttribute('href'))!.split('/').at(-1)!
  await filesPage(page)
  // 先等本页文件出现，再等刷新完成；挂载前的 enabled 状态不代表初始读取已结束。
  await expect(item.getByRole('link')).toBeVisible()
  await expect(page.getByRole('button', { name: '刷新文件列表' })).toBeEnabled()
  let deletes = 0
  let reads = 0
  let deliver = false
  await page.route(`**/api/files/${id}`, async route => {
    if (route.request().method() !== 'DELETE') { await route.continue(); return }
    deletes++
    if (deliver) await route.fetch()
    await route.abort()
  })
  const countReads = (request: import('@playwright/test').Request) => {
    if (/\/api\/(files(?:\/|\?|$)|storage)/.test(request.url()) && request.method() !== 'DELETE') reads++
  }
  page.on('request', countReads)
  page.once('dialog', dialog => dialog.accept())
  await item.getByRole('button', { name: '删除服务器文件', exact: true }).click()
  await expect(item).toContainText('删除结果未确认：请手动刷新')
  await page.clock.runFor(10000)
  expect(reads).toBe(0)
  expect(deletes).toBe(1)
  await refresh(page)
  await expect(page.getByRole('button', { name: '刷新文件列表' })).toBeEnabled()
  // 可用快照不能证明先前请求已取消；当前文件页保留警告和再次确认。
  await expect(item).toContainText('删除结果未确认')
  await expect(item.getByRole('link')).toHaveCount(0)
  await expect(item.getByRole('button', { name: '再次确认删除' })).toBeVisible()
  await messagesPage(page)
  await expect(item).not.toContainText('删除结果未确认')
  await expect(item.getByRole('link')).toBeVisible()
  await filesPage(page)
  await expect(item.getByRole('link')).toBeVisible()
  await expect(item).not.toContainText('删除结果未确认')
  await expect(item.getByRole('button', { name: '删除服务器文件', exact: true })).toBeVisible()
  // 真正接受删除后丢弃响应，仍须用户刷新，不能自动查询或宣称完成。
  deliver = true
  await expect(page.getByRole('button', { name: '刷新文件列表' })).toBeEnabled()
  const before = reads
  page.once('dialog', dialog => dialog.accept())
  await item.getByRole('button', { name: '删除服务器文件', exact: true }).click()
  await expect(item).toContainText('删除结果未确认')
  await deleted(page, id)
  await page.clock.runFor(10000)
  expect(reads).toBe(before)
  await expect(item).toContainText('删除结果未确认')
  expect(deletes).toBe(2)
  await refresh(page)
  await expect(item).toHaveCount(0)
  await messagesPage(page)
  await expect(item).toContainText('服务器文件已删除')
  page.off('request', countReads)
  await page.unrouteAll({ behavior: 'wait' })
}

// 活动读取竞争的真实后端证据在 files.rs；这里只注入冲突，验证浏览器不排队重发。
async function verifyRejectedDeletion(page: Page) {
  const name = 'delete-in-use.txt'
  await page.locator('input[type="file"]').setInputFiles({ name, mimeType: '', buffer: Buffer.from('busy') })
  const item = row(page, name)
  await expect(item.getByRole('link')).toBeVisible()
  const id = (await item.getByRole('link').getAttribute('href'))!.split('/').at(-1)!
  let deletes = 0
  await page.route(`**/api/files/${id}`, async route => {
    if (route.request().method() !== 'DELETE') { await route.continue(); return }
    deletes++
    await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ code: 'FILE_IN_USE', message: 'File in use' }) })
  })
  await filesPage(page)
  page.once('dialog', dialog => dialog.accept())
  await item.getByRole('button', { name: '删除服务器文件', exact: true }).click()
  await expect(item).toContainText('本次删除已结束')
  await expect(item.getByRole('link')).toBeVisible()
  await page.clock.runFor(10000)
  expect(deletes).toBe(1)
  await page.unrouteAll({ behavior: 'wait' })
  await messagesPage(page)
}

async function verifyCleanup(page: Page) {
  const name = 'delete-cleanup.txt'
  await page.locator('input[type="file"]').setInputFiles({ name, mimeType: '', buffer: Buffer.from('cleanup') })
  const item = row(page, name)
  await expect(item.getByRole('link')).toBeVisible()
  const id = (await item.getByRole('link').getAttribute('href'))!.split('/').at(-1)!
  // 仅在本次隔离 fixture 的合成实体上制造清理失败，不改生产目录。
  const root = process.env.TEST_FILES!
  expect(root).toMatch(/^\/tmp\/filehop-browser-[^/]+\/files$/)
  expect(id).toMatch(/^[0-9a-f-]{36}$/)
  const entity = join(root, id)
  await unlink(entity)
  await mkdir(entity)
  await filesPage(page)
  const usage = page.getByRole('region', { name: '应用文件额度', exact: true })
  await expect(usage).toContainText('待清理占用：0 B')
  page.once('dialog', dialog => dialog.accept())
  await item.getByRole('button', { name: '删除服务器文件', exact: true }).click()
  await expect(item).toContainText('删除处理中，空间尚未释放')
  await expect(usage).toContainText('待清理占用：0 B')
  await refresh(page)
  await expect(usage).toContainText('待清理占用：7 B')
  await expect(item.getByRole('link')).toHaveCount(0)
  await rmdir(entity)
  await deleted(page, id)
  await refresh(page)
  await expect(item).toHaveCount(0)
  await expect(usage).toContainText('待清理占用：0 B')
  await messagesPage(page)
  await expect(item).toContainText('服务器文件已删除')
}
