import { expect, type Page } from '@playwright/test'

export async function verifyLogout(page: Page) {
  const sibling = await page.context().newPage()
  await sibling.goto('/')
  await expect(sibling.getByRole('region', { name: '消息流' })).toBeVisible()
  const independent = await page.context().browser()!.newContext({ baseURL: new URL(page.url()).origin })
  const other = await independent.newPage()
  await other.goto('/')
  await other.getByLabel('用户名').fill('Admin')
  await other.getByLabel('密码', { exact: true }).fill(' synthetic password ')
  await other.getByRole('button', { name: '登录', exact: true }).click()
  await expect(other.getByRole('region', { name: '消息流' })).toBeVisible()

  // 暂存真实成功读取，再丢弃退出请求，验证未知结果不是普通登录失效。
  let release!: () => void
  let arrived!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const read = new Promise<void>(resolve => { arrived = resolve })
  await sibling.route('**/api/session', async route => {
    if (route.request().method() !== 'GET') return route.continue()
    const response = await route.fetch()
    arrived()
    await held
    await route.fulfill({ response })
  })
  await sibling.getByRole('button', { name: '检查登录状态' }).click()
  await read
  await page.route('**/api/session', route => route.request().method() === 'DELETE' ? route.abort() : route.continue())
  await page.getByRole('button', { name: '退出登录', exact: true }).click()
  for (const tab of [page, sibling]) {
    await expect(tab.getByRole('region', { name: '消息流' })).toHaveCount(0)
    await expect(tab.getByRole('status')).toContainText('退出未确认')
    await expect(tab.getByRole('button', { name: '重试退出' })).toBeEnabled()
  }
  const late = sibling.waitForResponse('**/api/session')
  release()
  await late
  await sibling.unroute('**/api/session')
  await sibling.bringToFront()
  await sibling.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await expect(sibling.getByRole('status')).toContainText('退出未确认')
  await expect(sibling.getByRole('region', { name: '消息流' })).toHaveCount(0)

  // 没有持久化退出锁：新页面和刷新仍能识别尚未被撤销的 Cookie。
  const fresh = await page.context().newPage()
  await fresh.goto('/')
  await expect(fresh.getByRole('region', { name: '消息流' })).toBeVisible()
  await fresh.reload()
  await expect(fresh.getByRole('region', { name: '消息流' })).toBeVisible()
  await sibling.getByRole('button', { name: '重试退出' }).click()
  for (const tab of [page, sibling, fresh]) {
    await expect(tab.getByRole('button', { name: '登录', exact: true })).toBeVisible()
    await expect(tab.getByRole('region', { name: '消息流' })).toHaveCount(0)
  }
  await other.getByRole('button', { name: '检查登录状态' }).click()
  await expect(other.getByRole('region', { name: '消息流' })).toBeVisible()
  await page.unroute('**/api/session')
  await page.reload()
  await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible()

  await page.getByLabel('用户名').fill('Admin')
  await page.getByLabel('密码', { exact: true }).fill(' synthetic password ')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByRole('region', { name: '消息流' })).toBeVisible()
  await sibling.reload()
  await expect(sibling.getByRole('region', { name: '消息流' })).toBeVisible()
  // 服务端已撤销但响应丢失：仍先显示未确认，由任意标签页幂等重试收敛。
  await page.route('**/api/session', async route => {
    if (route.request().method() !== 'DELETE') return route.continue()
    const response = await route.fetch()
    await route.fulfill({ response, status: 502, contentType: 'text/plain', body: 'response lost' })
  })
  await page.getByRole('button', { name: '退出登录', exact: true }).click()
  await expect(page.getByRole('button', { name: '重试退出' })).toBeEnabled()
  await expect(sibling.getByRole('status')).toContainText('退出未确认')
  await page.unroute('**/api/session')
  let releaseRetries!: () => void
  const retryBarrier = new Promise<void>(resolve => { releaseRetries = resolve })
  let arrivedRetries = 0
  for (const tab of [page, sibling]) {
    await tab.route('**/api/session', async route => {
      const response = await route.fetch()
      arrivedRetries++
      await retryBarrier
      await route.fulfill({ response })
    })
  }
  await page.getByRole('button', { name: '重试退出' }).click()
  await sibling.getByRole('button', { name: '重试退出' }).click()
  await expect.poll(() => arrivedRetries).toBe(2)
  releaseRetries()
  await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible()
  await expect(sibling.getByRole('button', { name: '登录', exact: true })).toBeVisible()
  await page.unroute('**/api/session')
  await sibling.unroute('**/api/session')
  await sibling.close()
  await fresh.close()
  await independent.close()
}
