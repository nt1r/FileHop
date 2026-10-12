import { expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import type { FileStatus, Message } from '../src/messages'

// 同一文件共享一次性实例；前置失败时停止后继，不在重启的 worker 中重复初始化。
test.describe.configure({ mode: 'serial' })

test.beforeAll(() => {
  execFileSync('cargo', ['test', '--manifest-path', resolve('../backend/Cargo.toml'), '--locked', '--test', 'initialization', 'initialize_external_fixture', '--', '--ignored', '--exact'], {
    timeout: 120_000,
    env: { ...process.env, FILEHOP_FIXTURE_COMMAND: resolve('../backend/target/debug/backend'),
      FILEHOP_FIXTURE_ARGS: JSON.stringify(['--database-dir', process.env.TEST_DATABASE!, '--files-dir', process.env.TEST_FILES!, 'init', '--username', 'Admin', '--confirm-paths']) },
  })
})

test.beforeEach(async ({ page }) => {
  await page.clock.install()
  await page.goto('/')
  await page.getByLabel('用户名').fill('Admin')
  await page.getByLabel('密码', { exact: true }).fill(' synthetic password ')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByRole('region', { name: '消息流' })).toBeVisible()
})

const row = (page: Page, name: string) => page.getByRole('article').filter({ hasText: name })
const filesPage = (page: Page) => page.getByRole('link', { name: '服务器文件', exact: true }).click()
const messagesPage = (page: Page) => page.getByRole('link', { name: '消息工作区', exact: true }).click()
async function remove(page: Page, name: string) {
  const id = (await row(page, name).getByRole('link').getAttribute('href'))!.split('/').at(-1)!
  page.once('dialog', dialog => dialog.accept())
  await row(page, name).getByRole('button', { name: '删除服务器文件', exact: true }).click()
  // 后台清理使用服务端时钟；客户端不轮询，完成后显式刷新快照。
  await expect.poll(async () => (await (await page.request.get(`/api/files/${id}/status`)).json()).file_state, { timeout: 15000 }).toBe('deleted')
  await page.getByRole('button', { name: '刷新文件列表' }).click()
  await expect(row(page, name)).toHaveCount(0)
}
async function upload(page: Page, name: string) {
  await page.locator('input[type="file"]').setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from('abc') })
  await expect(row(page, name).getByRole('link')).toBeVisible()
}
async function expectDeleted(page: Page, name: string) {
  await expect(row(page, name)).toHaveCount(1)
  await expect(row(page, name)).toContainText('服务器文件已删除')
  await expect(row(page, name).getByRole('link')).toHaveCount(0)
}

// 屏障保留真实后端返回的旧快照，只改变到达顺序；显式确认旧内容，避免测试误用了已删除的新响应。
async function holdResponse<T>(page: Page, pattern: string, inspect: (value: T) => void) {
  let release!: () => void
  let arrived!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const received = new Promise<void>(resolve => { arrived = resolve })
  let captured = false
  await page.route(pattern, async route => {
    if (captured) { await route.continue(); return }
    captured = true
    const response = await route.fetch()
    expect(response.ok()).toBe(true)
    inspect(await response.json())
    arrived()
    await held
    await route.fulfill({ response })
  })
  return { received, release: async () => {
    const response = page.waitForResponse(pattern)
    release()
    await (await response).finished()
  } }
}

test('only the files page deletes and completion requires manual refresh', async ({ page }) => {
  const name = 'manual-delete.txt'
  await upload(page, name)
  // 先推进新增游标，避免常规新增消息读取恰好携带此文件的新状态。
  await page.getByRole('button', { name: '读取最近消息' }).click()
  await expect(page.getByRole('button', { name: '读取最近消息' })).toBeEnabled()
  await expect(row(page, name).getByRole('button', { name: '删除服务器文件' })).toHaveCount(0)
  await filesPage(page)
  await expect(page.getByRole('button', { name: '刷新文件列表' })).toBeEnabled()
  const usage = page.getByRole('region', { name: '应用文件额度', exact: true })
  await expect(usage).toContainText('已保存文件：3 B')
  const id = (await row(page, name).getByRole('link').getAttribute('href'))!.split('/').at(-1)!
  let reads = 0
  page.on('request', request => {
    if (/\/api\/(files(?:\/|\?|$)|storage)/.test(request.url()) && request.method() !== 'DELETE') reads++
  })
  page.once('dialog', dialog => dialog.accept())
  await row(page, name).getByRole('button', { name: '删除服务器文件', exact: true }).click()
  await expect(row(page, name)).toContainText('删除处理中，空间尚未释放')
  await expect.poll(async () => (await (await page.request.get(`/api/files/${id}/status`)).json()).file_state, { timeout: 15000 }).toBe('deleted')
  await page.clock.runFor(10000)
  expect(reads).toBe(0)
  await expect(row(page, name)).toContainText('删除处理中，空间尚未释放')
  await expect(usage).toContainText('已保存文件：3 B')
  await page.getByRole('button', { name: '刷新文件列表' }).click()
  await expect(row(page, name)).toHaveCount(0)
  await expect(usage).toContainText('已保存文件：0 B')
  await messagesPage(page)
  await expectDeleted(page, name)
})

test('deleting a loaded cursor boundary preserves file and message pagination', async ({ page }) => {
  // 52 个真实上传跨越默认 50 条边界；不缩小 API 页长，也不直接填数据库。
  const names = Array.from({ length: 52 }, (_, n) => `pagination-${String(n).padStart(2, '0')}.txt`)
  const origin = new URL(page.url()).origin
  for (const name of names) {
    const send = crypto.randomUUID(), attempt = crypto.randomUUID()
    // 准备与后台清理共享短时准入锁，合法的 429 不代表分页失败。
    // 仅样本准备在有限期限内复用同一身份；其他错误立即失败，不重跑测试或 DELETE。
    let prepared!: Awaited<ReturnType<typeof page.request.post>>
    await expect.poll(async () => {
      prepared = await page.request.post('/api/file-sends', { headers: { origin }, data: {
        send_id: send, attempt_id: attempt, name, size: 1, mime: '', source_label: 'Pagination',
      } })
      return prepared.status() !== 429 || (await prepared.json()).code !== 'transfer_busy'
    }, { timeout: 10000, intervals: [1000] }).toBe(true)
    expect(prepared.ok()).toBe(true)
    const uploaded = await page.request.put(`/api/file-sends/${send}/attempts/${attempt}/content`, { headers: { origin }, data: 'x' })
    expect(uploaded.ok()).toBe(true)
  }
  await page.reload()
  await expect(page.getByRole('article')).toHaveCount(50)
  await expect(page.getByRole('article').first()).toContainText(names[2])
  await filesPage(page)
  await expect(page.getByRole('article')).toHaveCount(50)
  await expect(page.getByRole('article').last()).toContainText(names[2])
  await remove(page, names[2])
  await page.getByRole('button', { name: '加载更多文件' }).click()
  await expect(page.getByRole('article')).toHaveCount(51)
  await expect(page.getByRole('article').getByRole('heading')).toHaveText(names.filter(n => n !== names[2]).reverse())
  await expect(page.getByRole('button', { name: '加载更多文件' })).toHaveCount(0)
  await messagesPage(page)
  await expectDeleted(page, names[2])
  await page.getByRole('button', { name: '加载更早消息', exact: true }).click()
  await expect(page.getByRole('article')).toHaveCount(53)
  await expect(page.getByRole('article').filter({ hasText: 'pagination-' })).toHaveText(names.map(name => new RegExp(name.replace('.', '\\.'))))
  await expectDeleted(page, names[2])
  await expect(page.getByRole('button', { name: '加载更早消息', exact: true })).toHaveCount(0)
})

test('late history and batch status cannot resurrect a deleted file', async ({ page }) => {
  const name = 'ordered-history.txt'
  await upload(page, name)
  const id = (await row(page, name).getByRole('link').getAttribute('href'))!.split('/').at(-1)!
  // 上传回执不会推进增量游标，所以这次读取仍包含可用状态的原文件消息。
  const history = await holdResponse<{ messages: Message[] }>(page, '**/api/messages?after=*', value => {
    const file = value.messages.find(m => m.kind === 'FILE' && m.file_id === id)
    expect(file?.kind === 'FILE' && file.file_state).toBe('available')
  })
  await page.getByRole('button', { name: '读取最近消息' }).click()
  await history.received
  await filesPage(page)
  await expect(row(page, name)).toBeVisible()
  await expect(page.getByRole('button', { name: '刷新文件列表' })).toBeEnabled()
  const status = await holdResponse<{ files: FileStatus[] }>(page, '**/api/files/status-query', value => {
    expect(value.files.find(f => f.file_id === id)?.file_state).toBe('available')
  })
  await page.getByRole('button', { name: '刷新文件列表' }).click()
  await status.received
  // 批量旧读取仍在途；从另一客户端完成删除，再重入文件页取得新快照。
  const deletion = await page.request.delete(`/api/files/${id}`, { headers: { origin: new URL(page.url()).origin } })
  expect(deletion.status()).toBe(202)
  await expect.poll(async () => (await (await page.request.get(`/api/files/${id}/status`)).json()).file_state, { timeout: 15000 }).toBe('deleted')
  await messagesPage(page)
  await filesPage(page)
  await expect(row(page, name)).toHaveCount(0)
  await status.release()
  await expect(page.getByRole('button', { name: '刷新文件列表' })).toBeEnabled()
  await expect(row(page, name)).toHaveCount(0)
  await messagesPage(page)
  await expectDeleted(page, name)
  await history.release()
  await expect(page.getByRole('button', { name: '读取最近消息' })).toBeEnabled()
  await expectDeleted(page, name)
  await filesPage(page)
  await expect(page.getByRole('button', { name: '刷新文件列表' })).toBeEnabled()
  await expect(row(page, name)).toHaveCount(0)
})

test('leaving the files page discards pending deletion callbacks across login', async ({ page }) => {
  const name = 'discard-delete-context.txt'
  await upload(page, name)
  const id = (await row(page, name).getByRole('link').getAttribute('href'))!.split('/').at(-1)!
  await filesPage(page)
  // 保留真实拒绝响应：旧认证失效不能在用户重新登录后再次隐藏新界面。
  let release!: () => void
  let arrived!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const received = new Promise<void>(resolve => { arrived = resolve })
  await page.route(`**/api/files/${id}`, async route => {
    if (route.request().method() !== 'DELETE') { await route.continue(); return }
    await page.request.delete('/api/session', { headers: { origin: new URL(page.url()).origin } })
    const response = await route.fetch()
    expect(response.status()).toBe(401)
    arrived()
    await held
    await route.fulfill({ response })
  }, { times: 1 })
  page.once('dialog', dialog => dialog.accept())
  await row(page, name).getByRole('button', { name: '删除服务器文件', exact: true }).click()
  await received
  await expect(row(page, name)).toContainText('删除请求处理中')
  // 重入消息页的正常状态校正会发现会话失效，无需另发检查请求。
  await messagesPage(page)
  await expect(page.getByLabel('用户名')).toBeVisible()
  await page.getByLabel('用户名').fill('Admin')
  await page.getByLabel('密码', { exact: true }).fill(' synthetic password ')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await filesPage(page)
  await expect(row(page, name).getByRole('button', { name: '删除服务器文件', exact: true })).toBeEnabled()
  const late = page.waitForResponse(`**/api/files/${id}`)
  release()
  await late
  await page.clock.runFor(100)
  await expect(row(page, name).getByRole('link')).toBeVisible()
  await expect(row(page, name)).not.toContainText('删除请求处理中')
  await expect(page.getByLabel('用户名')).toHaveCount(0)
})

test('late send result keeps the manually refreshed completed version', async ({ page }) => {
  const name = 'ordered-send-result.txt'
  let sendId = ''
  await page.route('**/api/file-sends/*/attempts/*/content', async route => {
    const response = await route.fetch()
    sendId = (await response.json()).send_id
    await route.abort()
  }, { times: 1 })
  await page.locator('input[type="file"]').setInputFiles({ name, mimeType: '', buffer: Buffer.from('abc') })
  const task = page.locator('.upload-task').filter({ hasText: name })
  await expect(task).toContainText('结果未确认')
  const result = await holdResponse<{ message: FileStatus }>(page, `**/api/file-sends/${sendId}`, value => {
    expect(value.message.file_state).toBe('available')
  })
  await task.getByRole('button', { name: '查询文件结果' }).click()
  await result.received
  await filesPage(page)
  const id = (await row(page, name).getByRole('link').getAttribute('href'))!.split('/').at(-1)!
  // DELETE 先不送达；随后显式从另一客户端接受删除，靠手动刷新得知完成。
  await page.route(`**/api/files/${id}`, route => route.abort(), { times: 1 })
  page.once('dialog', dialog => dialog.accept())
  await row(page, name).getByRole('button', { name: '删除服务器文件', exact: true }).click()
  await expect(row(page, name)).toContainText('删除结果未确认')
  const deletion = await page.request.delete(`/api/files/${id}`, { headers: { origin: new URL(page.url()).origin } })
  expect(deletion.status()).toBe(202)
  await expect.poll(async () => (await (await page.request.get(`/api/files/${id}/status`)).json()).file_state, { timeout: 15000 }).toBe('deleted')
  await page.getByRole('button', { name: '刷新文件列表' }).click()
  await expect(page.getByRole('button', { name: '刷新文件列表' })).toBeEnabled()
  await expect(row(page, name)).toHaveCount(0)
  await messagesPage(page)
  await result.release()
  await expect(task).toContainText('上传成功')
  await expectDeleted(page, name)
  await expect(row(page, name)).not.toContainText('删除结果未确认')
  await filesPage(page)
  await expect(page.getByRole('button', { name: '刷新文件列表' })).toBeEnabled()
  await expect(row(page, name)).toHaveCount(0)
})
