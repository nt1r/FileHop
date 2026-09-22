import { expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export async function verifyMessages(page: Page) {
  const context = await page.context().browser()!.newContext({ baseURL: new URL(page.url()).origin, permissions: ['clipboard-read', 'clipboard-write'] })
  const other = await context.newPage()
  await other.goto('/')
  await other.getByLabel('用户名').fill('Admin')
  await other.getByLabel('密码', { exact: true }).fill(' synthetic password ')
  await other.getByRole('button', { name: '登录', exact: true }).click()
  await expect(other.getByRole('region', { name: '消息流' })).toBeVisible()
  const text = '  <b>hello</b>\n**中文** https://example.invalid\n '
  await page.getByLabel('来源标签').fill('\u0085 Desk \u3000')
  await page.getByLabel('正文', { exact: true }).fill(text)
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(page.getByLabel('正文', { exact: true })).toHaveValue('')
  await expect(page.getByLabel('来源标签')).toHaveValue('Desk')
  await other.getByRole('button', { name: '读取最近消息' }).click()
  const message = other.getByRole('article').filter({ hasText: '<b>hello</b>' })
  await expect(message.locator('pre')).toHaveText(text)
  expect(await message.locator('b, a').count()).toBe(0)
  await message.getByRole('button', { name: '复制正文' }).click()
  await expect(other.getByText('已复制完整正文')).toBeVisible()
  expect(await other.evaluate(() => navigator.clipboard.readText())).toBe(text)
  await other.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error('denied') } })
  await message.getByRole('button', { name: '复制正文' }).click()
  await expect(other.getByText('复制失败，请手动选择正文复制')).toBeVisible()
  await other.getByLabel('正文', { exact: true }).fill('reply')
  await other.getByLabel('正文', { exact: true }).press('Enter')
  await expect(other.getByLabel('正文', { exact: true })).toHaveValue('reply\n')
  await other.getByLabel('正文', { exact: true }).press('Control+Enter')
  await expect(other.getByLabel('正文', { exact: true })).toHaveValue('')
  await page.getByRole('button', { name: '读取最近消息' }).click()
  await expect(page.getByRole('article').filter({ hasText: 'reply' })).toHaveCount(1)
  await page.getByRole('button', { name: '读取最近消息' }).click()
  await expect(page.getByRole('article').filter({ hasText: '<b>hello</b>' })).toHaveCount(1)
  await context.close()
}

export async function verifyMessageSafety(page: Page) {
  const draft = page.getByLabel('正文', { exact: true })
  const send = page.getByRole('button', { name: '发送', exact: true })
  const cases = JSON.parse(readFileSync(resolve('../tests/text-cases.json'), 'utf8')) as { text: string; valid: boolean }[]
  for (const sample of cases) {
    await draft.fill(sample.text)
    if (sample.valid) await expect(send).toBeEnabled()
    else await expect(send).toBeDisabled()
  }
  await draft.fill('😀'.repeat(16384))
  await expect(send).toBeEnabled()
  await draft.fill('😀'.repeat(16384) + 'a')
  await expect(send).toBeDisabled()
  await draft.fill('composition guarded')
  await draft.dispatchEvent('compositionstart')
  await draft.press('Control+Enter')
  await expect(draft).toHaveValue('composition guarded')
  await draft.dispatchEvent('compositionend')

  let posts = 0
  await page.route('**/api/messages', async route => {
    if (route.request().method() === 'POST') {
      posts++
      const response = await route.fetch()
      await route.fulfill({ response, status: 502, contentType: 'text/plain', body: 'response lost' })
    } else await route.continue()
  })
  await send.dblclick({ force: true })
  await expect(page.getByText('结果未确认：', { exact: false })).toBeVisible()
  await expect(draft).toHaveAttribute('readonly', '')
  await expect(send).toBeDisabled()
  expect(posts).toBe(1)
  // 已提交的未知发送跨同页登录保留身份，重新认证后的真实读取可确认，不能再 POST。
  await page.clock.fastForward(43_200_000)
  await expect(page.getByRole('region', { name: '消息流' })).toHaveCount(0)
  await page.getByLabel('用户名').fill('Admin')
  await page.getByLabel('密码', { exact: true }).fill(' synthetic password ')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(draft).toHaveValue('')
  expect(posts).toBe(1)
  await page.getByLabel('来源标签').fill('Renamed')
  await page.getByRole('button', { name: '读取最近消息' }).click()
  await expect(draft).toHaveValue('')
  const original = page.getByRole('article').filter({ hasText: 'composition guarded' })
  await expect(original).toHaveCount(1)
  await expect(original).toContainText('Desk')
  await page.unroute('**/api/messages')

  await page.route('**/api/messages', route => route.request().method() === 'POST'
    ? route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ code: 'empty_text', message: '合成明确拒绝' }) })
    : route.continue())
  await draft.fill('rejected draft')
  await send.click()
  await expect(page.getByText('未保存：合成明确拒绝')).toBeVisible()
  await expect(draft).toBeEditable()
  await page.unroute('**/api/messages')
  await page.route('**/api/messages', route => route.request().method() === 'POST'
    ? route.fulfill({ status: 401, contentType: 'text/html', body: 'outer gate' })
    : route.continue())
  await send.click()
  await expect(page.getByText('结果未确认：', { exact: false })).toBeVisible()
  await expect(draft).toHaveValue('rejected draft')
  await expect(send).toBeDisabled()
  await page.unroute('**/api/messages')
  page.once('dialog', dialog => dialog.accept())
  await page.reload()
  await expect(draft).toHaveValue('')

  let releaseUncommitted!: () => void
  let arrivedUncommitted!: () => void
  const heldUncommitted = new Promise<void>(resolve => { releaseUncommitted = resolve })
  const receivedUncommitted = new Promise<void>(resolve => { arrivedUncommitted = resolve })
  await page.route('**/api/messages', async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return }
    arrivedUncommitted()
    await heldUncommitted
    await route.abort()
  })
  await draft.fill('uncommitted during expiry')
  await send.click()
  await receivedUncommitted
  await page.clock.fastForward(43_200_000)
  await expect(page.getByRole('region', { name: '消息流' })).toHaveCount(0)
  releaseUncommitted()
  await page.unrouteAll({ behavior: 'wait' })
  await page.getByLabel('用户名').fill('Admin')
  await page.getByLabel('密码', { exact: true }).fill(' synthetic password ')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByText('结果未确认：', { exact: false })).toBeVisible()
  await expect(draft).toHaveValue('uncommitted during expiry')
  await expect(send).toBeDisabled()
  page.once('dialog', dialog => dialog.accept())
  await page.reload()
  await expect(draft).toHaveValue('')

  await draft.fill('memory-only draft')
  await page.clock.fastForward(43_200_000)
  await expect(page.getByRole('region', { name: '消息流' })).toHaveCount(0)
  await page.getByLabel('用户名').fill('Admin')
  await page.getByLabel('密码', { exact: true }).fill(' synthetic password ')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(draft).toHaveValue('memory-only draft')
  await expect(page.getByRole('article').filter({ hasText: 'memory-only draft' })).toHaveCount(0)
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain('memory-only')
  page.once('dialog', dialog => dialog.accept())
  await page.reload()
  await expect(draft).toHaveValue('')
  await expect(page.getByLabel('来源标签')).toHaveValue('Renamed')

  let release!: () => void
  let arrived!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const received = new Promise<void>(resolve => { arrived = resolve })
  await page.route('**/api/messages', async route => {
    if (route.request().method() === 'POST') {
      const response = await route.fetch()
      arrived()
      await held
      await route.fulfill({ response })
    } else await route.continue()
  })
  const sibling = await page.context().newPage()
  await sibling.goto('/')
  await expect(sibling.getByLabel('正文', { exact: true })).toBeVisible()
  await sibling.getByLabel('正文', { exact: true }).fill('sibling private draft')
  await draft.fill('late committed text')
  await send.click()
  await received
  page.once('dialog', dialog => dialog.dismiss())
  await page.getByRole('button', { name: '退出登录' }).click()
  await expect(draft).toHaveValue('late committed text')
  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: '退出登录' }).click()
  await expect(page.getByRole('region', { name: '消息流' })).toHaveCount(0)
  await expect(sibling.getByRole('region', { name: '消息流' })).toHaveCount(0)
  const late = page.waitForResponse('**/api/messages')
  release()
  await late
  await page.unroute('**/api/messages')
  await expect(page.getByRole('region', { name: '消息流' })).toHaveCount(0)
  await page.getByLabel('用户名').fill('Admin')
  await page.getByLabel('密码', { exact: true }).fill(' synthetic password ')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(draft).toHaveValue('')
  await expect(page.getByRole('article').filter({ hasText: 'late committed text' })).toHaveCount(1)
  await sibling.close()
  for (let n = 0; n < 50; n++) {
    const response = await page.request.post('/api/messages', { headers: { origin: new URL(page.url()).origin }, data: {
      send_id: crypto.randomUUID(), text: `recent positioning ${n}\n` + 'line\n'.repeat(12), source_label: 'Web',
    } })
    expect(response.status()).toBe(201)
  }
  await page.reload()
  await expect(page.getByRole('article').filter({ hasText: 'recent positioning 49' })).toBeInViewport()
}
