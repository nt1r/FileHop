import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { verifyLogout } from './logout'
import { verifyHistory } from './history'
import { verifySync } from './sync'
import { verifyMessages, verifyMessageSafety } from './messages'
import { verifySendRecovery } from './send-recovery'
import { verifyFiles } from './files'
import { verifyFileSession } from './file-session'
import { verifyFileLogout } from './file-logout'

test('administrator initializes storage and the page observes the real status', async ({ page }) => {
  test.setTimeout(90_000)
  await page.clock.install()
  await page.goto('/')
  await expect(page.getByRole('status')).toContainText('请管理员先初始化')
  expect(await page.getByRole('textbox').count()).toBe(0)
  execFileSync('cargo', ['test', '--manifest-path', resolve('../backend/Cargo.toml'), '--locked', '--test', 'initialization', 'initialize_external_fixture', '--', '--ignored', '--exact'], {
    timeout: 120_000,
    env: { ...process.env,
      FILEHOP_FIXTURE_COMMAND: resolve('../backend/target/debug/backend'),
      FILEHOP_FIXTURE_ARGS: JSON.stringify(['--database-dir', process.env.TEST_DATABASE!, '--files-dir', process.env.TEST_FILES!, 'init', '--username', 'Admin', '--confirm-paths']),
    },
  })
  await page.getByRole('button', { name: '刷新状态' }).click()
  await expect(page.getByRole('status')).toContainText('已初始化')
  // 真实登录、Cookie 恢复与浏览器时间推进只使用本次初始化的合成账户。
  await page.getByLabel('用户名').fill('ADMIN')
  await page.getByLabel('密码', { exact: true }).fill(' synthetic password ')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByRole('region', { name: '消息流' })).toBeVisible()
  const cookies = await page.context().cookies()
  const session = cookies.find(cookie => cookie.name === '__Host-filehop')!
  expect(session.secure).toBe(true)
  expect(session.httpOnly).toBe(true)
  expect(session.sameSite).toBe('Lax')
  await page.reload()
  await expect(page.getByRole('region', { name: '消息流' })).toBeVisible()

  await page.route('**/api/session', route => route.fulfill({ status: 401, contentType: 'text/html', body: 'Access gate' }))
  await page.getByRole('button', { name: '检查登录状态' }).click()
  await expect(page.getByRole('status')).toContainText('无法确认登录状态')
  await expect(page.getByRole('region', { name: '消息流' })).toBeVisible()
  await page.unroute('**/api/session')

  await page.clock.fastForward(43_190_000)
  let releaseRead!: () => void
  let readArrived!: () => void
  const held = new Promise<void>(resolve => { releaseRead = resolve })
  const arrived = new Promise<void>(resolve => { readArrived = resolve })
  await page.route('**/api/session', async route => {
    const response = await route.fetch()
    readArrived()
    await held
    await route.fulfill({ response })
  })
  await page.getByRole('button', { name: '检查登录状态' }).click()
  await arrived
  await page.clock.fastForward(10_000)
  await expect(page.getByRole('region', { name: '消息流' })).toHaveCount(0)
  await expect(page.getByRole('status')).toContainText('登录已到期')
  const lateResponse = page.waitForResponse('**/api/session')
  releaseRead()
  await lateResponse
  await page.unroute('**/api/session')
  await expect(page.getByRole('region', { name: '消息流' })).toHaveCount(0)
  await page.getByLabel('用户名').fill('Admin')
  await page.getByLabel('密码', { exact: true }).fill(' synthetic password ')
  // 服务器完成登录并设置 Cookie 后，丢弃其响应内容；页面必须先查询而非重发 POST。
  let posts = 0
  await page.route('**/api/session', async route => {
    if (route.request().method() === 'POST') {
      posts++
      const response = await route.fetch()
      await route.fulfill({ response, status: 502, contentType: 'text/plain', body: 'response lost' })
    } else await route.continue()
  })
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByRole('region', { name: '消息流' })).toBeVisible()
  expect(posts).toBe(1)
  await page.unroute('**/api/session')
  await verifyMessages(page)
  await verifyMessageSafety(page)
  await verifyHistory(page)
  await verifySync(page)
  await verifySendRecovery(page)
  await verifyFileSession(page)
  await verifyFileLogout(page)
  await verifyFiles(page)
  await verifyLogout(page)
  writeFileSync(resolve(process.env.TEST_FILES!, 'storage-id'), 'mismatched')
  await page.reload()
  await expect(page.getByRole('status')).toContainText('存储异常')
  await page.route('**/api/status', route => route.fulfill({ status: 401, contentType: 'text/html', body: 'Access gate' }))
  await page.getByRole('button', { name: '刷新状态' }).click()
  await expect(page.getByRole('status')).toContainText('无法获取应用状态')
})
