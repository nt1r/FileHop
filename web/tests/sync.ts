import { expect, type Page } from '@playwright/test'

export async function verifySync(page: Page) {
  await page.reload()
  const refresh = page.getByRole('button', { name: '读取最近消息' })
  await expect(refresh).toBeEnabled()
  const origin = new URL(page.url()).origin
  for (let n = 0; n < 105; n++) {
    expect((await page.request.post('/api/messages', { headers: { origin }, data: {
      send_id: crypto.randomUUID(), text: `sync gap ${n}`, source_label: 'Sync',
    } })).status()).toBe(201)
  }
  const anchor = page.getByRole('article').first()
  await anchor.scrollIntoViewIfNeeded()
  const offset = async () => (await anchor.boundingBox())!.y - (await page.getByLabel('消息历史', { exact: true }).boundingBox())!.y
  const readingY = await offset()
  // 本地发送先返回也不能跳过服务器上尚未读取的 105 条消息。
  await page.getByLabel('正文', { exact: true }).fill('local ahead of sync')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(page.getByLabel('正文', { exact: true })).toHaveValue('')
  let failedBoundary = ''
  let pages = 0
  await page.route('**/api/messages?after=*', async route => {
    if (++pages === 2) { failedBoundary = route.request().url(); await route.abort() }
    else await route.continue()
  })
  await refresh.click()
  await expect(page.getByText('读取失败', { exact: false })).toBeVisible()
  await expect(page.getByRole('article').filter({ has: page.getByText('Sync', { exact: true }) })).toHaveCount(50)
  await page.unroute('**/api/messages?after=*')
  const resumed = page.waitForRequest('**/api/messages?after=*')
  await refresh.click()
  expect((await resumed).url()).toBe(failedBoundary)
  await expect(page.getByRole('article').filter({ has: page.getByText('Sync', { exact: true }) })).toHaveCount(105)
  await expect(page.getByRole('article').filter({ hasText: 'local ahead of sync' })).toHaveCount(1)
  await expect(refresh).toBeEnabled()
  expect(Math.abs(await offset() - readingY)).toBeLessThan(2)
  await page.getByRole('button', { name: '回到最新', exact: true }).click()
  await expect(page.getByRole('article').last()).toBeInViewport()
  const emptyRequest = page.waitForRequest('**/api/messages?after=*')
  await refresh.click()
  const emptyBoundary = (await emptyRequest).url()
  await expect(refresh).toBeEnabled()
  const repeated = page.waitForRequest('**/api/messages?after=*')
  await refresh.click()
  expect((await repeated).url()).toBe(emptyBoundary)
  await expect(refresh).toBeEnabled()

  // install 的时钟仍随真实时间前进；先暂停，避免执行断言本身跨过 Retry-After 边界。
  // 后续仅用 runFor 推进时间，消息与分页仍来自真实后端。
  const visibility = async (state: 'hidden' | 'visible') => page.evaluate(state => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
    document.dispatchEvent(new Event('visibilitychange'))
  }, state)
  let reads = 0
  let fail = true
  await page.route('**/api/messages?after=*', async route => {
    reads++
    if (fail) await route.abort()
    else await route.continue()
  })
  await visibility('hidden')
  // 暂停目标略晚于取时，留出自动化往返时间；隐藏状态下不会提前触发轮询。
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000))
  await page.clock.runFor(60000)
  expect(reads).toBe(0)
  await visibility('visible')
  await expect(page.getByText('读取失败', { exact: false })).toBeVisible()
  expect(reads).toBe(1)
  await page.clock.runFor(8999)
  expect(reads).toBe(1)
  await page.clock.runFor(1001)
  await expect.poll(() => reads).toBe(2)
  await expect(refresh).toBeEnabled()
  await page.clock.runFor(17999)
  expect(reads).toBe(2)
  await page.clock.runFor(2001)
  await expect.poll(() => reads).toBe(3)
  await expect(refresh).toBeEnabled()
  await page.clock.runFor(35999)
  expect(reads).toBe(3)
  await page.clock.runFor(4001)
  await expect.poll(() => reads).toBe(4)
  await expect(refresh).toBeEnabled()
  await page.clock.runFor(53999)
  expect(reads).toBe(4)
  fail = false
  await page.clock.runFor(6001)
  await expect.poll(() => reads).toBe(5)
  await expect(page.getByText('读取失败', { exact: false })).toHaveCount(0)
  await page.clock.runFor(10000)
  await expect.poll(() => reads).toBe(6)
  await expect(refresh).toBeEnabled()
  await page.unroute('**/api/messages?after=*')

  // Retry-After 同时约束定时、手动和前台恢复，不能靠连续点击绕过。
  reads = 0
  await page.route('**/api/messages?after=*', async route => {
    reads++
    await route.fulfill({ status: 429, headers: { 'Retry-After': '30' }, contentType: 'application/json', body: JSON.stringify({ code: 'limited', message: 'wait' }) })
  })
  await refresh.click()
  await expect(page.getByText('读取失败', { exact: false })).toBeVisible()
  await refresh.click()
  await visibility('hidden')
  await visibility('visible')
  await page.clock.runFor(29999)
  expect(reads).toBe(1)
  await page.unroute('**/api/messages?after=*')
  await page.clock.runFor(1)
  await expect(page.getByText('读取失败', { exact: false })).toHaveCount(0)

  // HTTP 日期和访问层非 JSON 错误同样必须遵守服务端冷却，不能误报会话失效。
  const deadline = await page.evaluate(() => new Date(Date.now() + 30000).toUTCString())
  reads = 0
  await page.route('**/api/messages?after=*', async route => {
    reads++
    await route.fulfill({ status: 503, headers: { 'Retry-After': deadline }, contentType: 'text/plain', body: 'unavailable' })
  })
  await refresh.click()
  await expect(page.getByText('读取失败', { exact: false })).toBeVisible()
  await page.clock.runFor(28000)
  await refresh.click()
  expect(reads).toBe(1)
  await page.unroute('**/api/messages?after=*')
  await page.clock.runFor(2000)
  await expect(page.getByText('读取失败', { exact: false })).toHaveCount(0)

  // 增量确认未知发送，放弃后的同一路径只能合并，不能清空新草稿。
  for (const abandon of [false, true]) {
    await page.route('**/api/messages', async route => {
      if (route.request().method() !== 'POST') { await route.continue(); return }
      const response = await route.fetch()
      await route.fulfill({ response, status: 502, contentType: 'text/plain', body: 'response lost' })
    })
    const text = `increment confirms ${abandon}`
    await page.getByLabel('正文', { exact: true }).fill(text)
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await expect(page.getByText('结果未确认：', { exact: false })).toBeVisible()
    await page.unroute('**/api/messages')
    if (abandon) {
      page.once('dialog', dialog => dialog.accept())
      await page.getByRole('button', { name: '放弃确认' }).click()
      await page.getByLabel('正文', { exact: true }).fill('new protected draft')
    }
    await refresh.click()
    await expect(page.getByRole('article').filter({ hasText: text })).toHaveCount(1)
    await expect(page.getByLabel('正文', { exact: true })).toHaveValue(abandon ? 'new protected draft' : '')
  }
  await page.getByLabel('正文', { exact: true }).fill('')

  // 在途读取不重叠；到期和跨标签页退出必须让迟到的增量结果失效。
  for (const exit of ['expiry', 'other-tab'] as const) {
    let release!: () => void
    let arrived!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const received = new Promise<void>(resolve => { arrived = resolve })
    let requests = 0
    await page.route('**/api/messages?after=*', async route => {
      requests++
      const response = await route.fetch()
      arrived()
      await held
      await route.fulfill({ response })
    })
    await refresh.click()
    await received
    await visibility('hidden')
    await visibility('visible')
    await page.clock.runFor(10000)
    expect(requests).toBe(1)
    await expect(refresh).toBeDisabled()
    if (exit === 'expiry') await page.clock.fastForward(43_200_000)
    else {
      const other = await page.context().newPage()
      await other.goto('/')
      await other.getByRole('button', { name: '退出登录' }).click()
      await expect(other.getByLabel('用户名')).toBeVisible()
      await other.close()
    }
    await expect(page.getByRole('region', { name: '消息流' })).toHaveCount(0)
    release()
    await page.unrouteAll({ behavior: 'wait' })
    await expect(page.getByRole('region', { name: '消息流' })).toHaveCount(0)
    await page.getByLabel('用户名').fill('Admin')
    await page.getByLabel('密码', { exact: true }).fill(' synthetic password ')
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await expect(page.getByRole('article')).toHaveCount(50)
    await expect(refresh).toBeEnabled()
  }
  reads = 0
  await page.route('**/api/messages?after=*', async route => {
    reads++
    await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ code: 'session_invalid', message: 'expired' }) })
  })
  await refresh.click()
  await expect(page.getByLabel('用户名')).toBeVisible()
  await page.clock.runFor(120000)
  expect(reads).toBe(1)
  await page.unroute('**/api/messages?after=*')
  await page.getByLabel('用户名').fill('Admin')
  await page.getByLabel('密码', { exact: true }).fill(' synthetic password ')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByRole('article')).toHaveCount(50)
}