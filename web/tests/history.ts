import { expect, type Page } from '@playwright/test'

export async function verifyHistory(page: Page) {
  const origin = new URL(page.url()).origin
  // 通过公开发送接口建立跨三页的合成历史，不依赖 SQLite 表结构。
  for (let n = 0; n < 105; n++) {
    const response = await page.request.post('/api/messages', { headers: { origin }, data: {
      send_id: crypto.randomUUID(), text: `paged history ${n}\n` + 'line\n'.repeat(5), source_label: 'History',
    } })
    expect(response.status()).toBe(201)
  }
  await page.reload()
  const articles = page.getByRole('article')
  const older = page.getByRole('button', { name: '加载更早消息', exact: true })
  await expect(articles).toHaveCount(50)
  await expect(articles.last()).toContainText('paged history 104')
  await expect(older).toBeVisible()
  const anchor = articles.filter({ hasText: 'paged history 60\n' })
  await anchor.scrollIntoViewIfNeeded()
  const y = (await anchor.boundingBox())!.y
  let firstBoundary = ''
  await page.route('**/api/messages?before=*', async route => {
    firstBoundary = route.request().url()
    await route.abort()
  })
  await older.click()
  await expect(page.getByText('加载更早消息失败，请重试')).toBeVisible()
  await expect(articles).toHaveCount(50)
  await page.unroute('**/api/messages?before=*')
  const retry = page.waitForRequest('**/api/messages?before=*')
  await older.click()
  expect((await retry).url()).toBe(firstBoundary)
  await expect(articles).toHaveCount(100)
  expect(Math.abs((await anchor.boundingBox())!.y - y)).toBeLessThan(2)

  // 阅读旧内容时发送和最近页读取不得抢走位置，同一服务器消息合并后只出现一次。
  await page.getByLabel('正文', { exact: true }).fill('new while reading history')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(page.getByLabel('正文', { exact: true })).toHaveValue('')
  await page.getByRole('button', { name: '读取最近消息' }).click()
  await expect(articles.filter({ hasText: 'new while reading history' })).toHaveCount(1)
  expect(Math.abs((await anchor.boundingBox())!.y - y)).toBeLessThan(2)
  await older.click()
  await expect(articles.filter({ hasText: 'paged history 0\n' })).toHaveCount(1)
  await expect(page.getByRole('button', { name: '读取最近消息' })).toBeEnabled()
  if (await older.count()) await older.click()
  await expect(older).toHaveCount(0)
  await page.getByRole('button', { name: '回到最新', exact: true }).click()
  await expect(articles.last()).toBeInViewport()
  await page.getByLabel('正文', { exact: true }).fill('follow newest at bottom')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(articles.last()).toContainText('follow newest at bottom')
  await expect(articles.last()).toBeInViewport()

  // 历史读取沿用认证代次：退出后即使真实响应迟到，也不能恢复内容或分页状态。
  await page.reload()
  await expect(older).toBeVisible()
  let release!: () => void
  let arrived!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const received = new Promise<void>(resolve => { arrived = resolve })
  await page.route('**/api/messages?before=*', async route => {
    const response = await route.fetch()
    arrived()
    await held
    await route.fulfill({ response })
  })
  await older.click()
  await received
  await page.getByRole('button', { name: '退出登录' }).click()
  await expect(page.getByRole('region', { name: '消息流' })).toHaveCount(0)
  const late = page.waitForResponse('**/api/messages?before=*')
  release()
  await late
  await page.unrouteAll({ behavior: 'wait' })
  await expect(page.getByRole('region', { name: '消息流' })).toHaveCount(0)
  await page.getByLabel('用户名').fill('Admin')
  await page.getByLabel('密码', { exact: true }).fill(' synthetic password ')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(articles).toHaveCount(50)

  // 未确认发送被其他消息挤出最近页后，旧页仍须走共同合并规则确认它。
  await page.route('**/api/messages', async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return }
    const response = await route.fetch()
    await route.fulfill({ response, status: 502, contentType: 'text/plain', body: 'response lost' })
  })
  await page.getByLabel('正文', { exact: true }).fill('unknown found in older history')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(page.getByText('结果未确认：', { exact: false })).toBeVisible()
  await page.unroute('**/api/messages')
  for (let n = 0; n < 51; n++) {
    const response = await page.request.post('/api/messages', { headers: { origin }, data: {
      send_id: crypto.randomUUID(), text: `later than unknown ${n}`, source_label: 'History',
    } })
    expect(response.status()).toBe(201)
  }
  await page.clock.fastForward(43_200_000)
  await expect(page.getByRole('region', { name: '消息流' })).toHaveCount(0)
  await page.getByLabel('用户名').fill('Admin')
  await page.getByLabel('密码', { exact: true }).fill(' synthetic password ')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(articles).toHaveCount(50)
  await expect(page.getByLabel('正文', { exact: true })).toHaveValue('unknown found in older history')
  await older.click()
  await expect(page.getByLabel('正文', { exact: true })).toHaveValue('')
  await expect(articles.filter({ hasText: 'unknown found in older history' })).toHaveCount(1)

  // 等旧页时仍可发送，响应顺序不能覆盖新消息；等待期间用户移动后的阅读位置也须保留。
  let releaseConcurrent!: () => void
  let arrivedConcurrent!: () => void
  const heldConcurrent = new Promise<void>(resolve => { releaseConcurrent = resolve })
  const receivedConcurrent = new Promise<void>(resolve => { arrivedConcurrent = resolve })
  await page.route('**/api/messages?before=*', async route => {
    const response = await route.fetch()
    arrivedConcurrent()
    await heldConcurrent
    await route.fulfill({ response })
  })
  await older.click()
  await receivedConcurrent
  await expect(older).toBeDisabled()
  const reading = articles.filter({ hasText: 'later than unknown 10' })
  await reading.scrollIntoViewIfNeeded()
  const readingOffset = async () => (await reading.boundingBox())!.y - (await page.getByLabel('消息历史', { exact: true }).boundingBox())!.y
  const readingY = await readingOffset()
  await page.getByLabel('正文', { exact: true }).fill('sent while old page pending')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(page.getByLabel('正文', { exact: true })).toHaveValue('')
  expect(Math.abs(await readingOffset() - readingY)).toBeLessThan(2)
  releaseConcurrent()
  await page.unrouteAll({ behavior: 'wait' })
  await expect(older).toBeEnabled()
  await expect(articles.filter({ hasText: 'sent while old page pending' })).toHaveCount(1)
  expect(Math.abs(await readingOffset() - readingY)).toBeLessThan(2)
}
