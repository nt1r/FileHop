import { expect, type Page } from '@playwright/test'

export async function verifySendRecovery(page: Page) {
  const draft = page.getByLabel('正文', { exact: true })
  const send = page.getByRole('button', { name: '发送', exact: true })
  const retry = page.getByRole('button', { name: '同次重试', exact: true })
  const query = page.getByRole('button', { name: '查询发送结果', exact: true })
  for (const action of [query, retry]) {
    const text = action === query ? 'recover by query' : 'recover by replay'
    let original: unknown
    await page.route('**/api/messages', async route => {
      if (route.request().method() !== 'POST') { await route.continue(); return }
      const body: unknown = route.request().postDataJSON()
      const response = await route.fetch()
      if (!original) {
        original = body
        await route.fulfill({ status: 502, contentType: 'text/plain', body: 'lost after commit' })
      } else {
        expect(body).toEqual(original)
        expect(response.status()).toBe(200)
        await route.fulfill({ response })
      }
    })
    await draft.fill(text)
    await send.click()
    await expect(page.getByText('结果未确认：', { exact: false })).toBeVisible()
    await page.getByLabel('来源标签').fill('Changed after send')
    await action.click()
    await expect(draft).toHaveValue('')
    await page.getByRole('button', { name: '读取最近消息' }).click()
    await expect(page.getByRole('article').filter({ hasText: text })).toHaveCount(1)
    await page.unroute('**/api/messages')
  }
  await verifyUncommittedRecovery(page)
  await verifyInFlightResult(page)
  await verifyAbandonedRecovery(page)
}

async function login(page: Page) {
  await page.getByLabel('用户名').fill('Admin')
  await page.getByLabel('密码', { exact: true }).fill(' synthetic password ')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByRole('region', { name: '消息流' })).toBeVisible()
}

async function verifyUncommittedRecovery(page: Page) {
  const draft = page.getByLabel('正文', { exact: true })
  let original: unknown
  let rejection = 502
  await page.route('**/api/messages', async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return }
    const body: unknown = route.request().postDataJSON()
    if (!original) original = body
    else expect(body).toEqual(original)
    if (rejection === 0) { await route.continue(); return }
    const code = ({ 401: 'session_invalid', 403: 'origin_rejected', 409: 'send_conflict', 429: 'rate_limited' } as Record<number, string>)[rejection] ?? 'unavailable'
    await route.fulfill({ status: rejection, contentType: 'application/json', body: JSON.stringify({ code, message: 'synthetic rejection' }) })
  })
  await draft.fill('identity survives login and rejected retries')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(page.getByText('结果未确认：', { exact: false })).toBeVisible()
  await page.getByRole('button', { name: '查询发送结果' }).click()
  await expect(page.getByText('暂未找到', { exact: false })).toBeVisible()
  await expect(draft).toHaveAttribute('readonly', '')
  for (rejection of [403, 429, 409, 401]) {
    await page.getByRole('button', { name: '同次重试' }).click()
    if (rejection === 401) {
      await expect(page.getByRole('region', { name: '消息流' })).toHaveCount(0)
      await login(page)
    }
    await expect(page.getByText('结果未确认：', { exact: false })).toBeVisible()
    if (rejection === 409) await expect(page.getByText('发送标识冲突', { exact: false })).toBeVisible()
    await expect(draft).toHaveValue('identity survives login and rejected retries')
    await expect(draft).toHaveAttribute('readonly', '')
  }
  rejection = 0
  await page.getByLabel('来源标签').fill('Later label')
  await page.getByRole('button', { name: '同次重试' }).click()
  await expect(draft).toHaveValue('')
  await expect(page.getByRole('article').filter({ hasText: 'identity survives login and rejected retries' })).toHaveCount(1)
  await page.unroute('**/api/messages')
}

async function verifyInFlightResult(page: Page) {
  const draft = page.getByLabel('正文', { exact: true })
  let release!: () => void
  let arrived!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const received = new Promise<void>(resolve => { arrived = resolve })
  await page.route('**/api/messages', async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return }
    arrived()
    await held
    const response = await route.fetch()
    expect(response.status()).toBe(201)
    await route.fulfill({ response })
  })
  await draft.fill('not found does not cancel in-flight send')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await received
  // 同页到期让仍在途的原请求成为未知；重新登录的历史与结果查询此时都读不到它。
  await page.clock.fastForward(43_200_000)
  await expect(page.getByRole('region', { name: '消息流' })).toHaveCount(0)
  await login(page)
  await page.getByRole('button', { name: '查询发送结果' }).click()
  await expect(page.getByText('暂未找到', { exact: false })).toBeVisible()
  await expect(draft).toHaveAttribute('readonly', '')
  release()
  await page.unrouteAll({ behavior: 'wait' })
  await page.getByRole('button', { name: '读取最近消息' }).click()
  await expect(draft).toHaveValue('')
  await expect(page.getByRole('article').filter({ hasText: 'not found does not cancel in-flight send' })).toHaveCount(1)
}

async function verifyAbandonedRecovery(page: Page) {
  const draft = page.getByLabel('正文', { exact: true })
  // 各轮分别让原重试、结果查询、历史读取在用户放弃后才返回，覆盖三条消息合并入口。
  for (const source of ['retry', 'query', 'history']) {
    const text = `abandoned ${source}`
    let original: { send_id: string } | undefined
    await page.route('**/api/messages', async route => {
      if (route.request().method() !== 'POST') { await route.continue(); return }
      original = route.request().postDataJSON() as { send_id: string }
      await route.fetch()
      await route.fulfill({ status: 502, contentType: 'text/plain', body: 'lost after commit' })
    })
    await draft.fill(text)
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await expect(page.getByText('结果未确认：', { exact: false })).toBeVisible()
    await page.unroute('**/api/messages')
    let release!: () => void
    let arrived!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const received = new Promise<void>(resolve => { arrived = resolve })
    const path = source === 'query' ? '**/api/sends/*' : '**/api/messages'
    await page.route(path, async route => {
      const response = await route.fetch()
      arrived()
      await held
      await route.fulfill({ response })
    })
    await page.getByRole('button', { name: source === 'query' ? '查询发送结果' : source === 'retry' ? '同次重试' : '读取最近消息' }).click()
    await received
    page.once('dialog', async dialog => {
      expect(dialog.message()).toContain('可能已经保存')
      await dialog.dismiss()
    })
    await page.getByRole('button', { name: '放弃确认' }).click()
    await expect(draft).toHaveAttribute('readonly', '')
    page.once('dialog', dialog => dialog.accept())
    await page.getByRole('button', { name: '放弃确认' }).click()
    await expect(draft).toHaveValue(text)
    await expect(draft).toBeEditable()
    await expect(page.getByText('再次发送可能重复', { exact: false })).toBeVisible()
    await draft.fill(`new draft after ${source}`)
    release()
    await page.unrouteAll({ behavior: 'wait' })
    await expect(page.getByRole('article').filter({ hasText: text })).toHaveCount(1)
    await expect(draft).toHaveValue(`new draft after ${source}`)
    // 主动再次发送相同正文是新操作，不是撤回或偷偷沿用旧标识。
    await draft.fill(text)
    const sent = page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith('/api/messages'))
    await page.getByRole('button', { name: '发送', exact: true }).click()
    expect((await sent).postDataJSON().send_id).not.toBe(original!.send_id)
    await expect(draft).toHaveValue('')
    await expect(page.getByRole('article').filter({ hasText: text })).toHaveCount(2)
  }
}
