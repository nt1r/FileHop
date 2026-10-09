import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

test('deep links, authentication redirects and history preserve the workspace', async ({ page }) => {
  test.setTimeout(120_000)
  execFileSync('cargo', ['test', '--manifest-path', resolve('../backend/Cargo.toml'), '--locked', '--test', 'initialization', 'initialize_external_fixture', '--', '--ignored', '--exact'], {
    timeout: 120_000,
    env: { ...process.env, FILEHOP_FIXTURE_COMMAND: resolve('../backend/target/debug/backend'),
      FILEHOP_FIXTURE_ARGS: JSON.stringify(['--database-dir', process.env.TEST_DATABASE!, '--files-dir', process.env.TEST_FILES!, 'init', '--username', 'Admin', '--confirm-paths']) },
  })
  await page.goto('/files')
  await expect(page).toHaveURL(/\/login\?next=%2Ffiles$/)
  await expect(page.getByRole('region', { name: '服务器文件' })).toHaveCount(0)
  await page.reload()
  await page.getByLabel('用户名').fill('Admin')
  await page.getByLabel('密码', { exact: true }).fill(' synthetic password ')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page).toHaveURL(/\/files$/)
  await expect(page.getByRole('region', { name: '服务器文件' })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('region', { name: '服务器文件' })).toBeVisible()
  await page.getByRole('link', { name: '消息工作区', exact: true }).click()
  await page.getByLabel('正文', { exact: true }).fill('routing draft')
  await page.getByRole('link', { name: '服务器文件', exact: true }).click()
  await page.goBack()
  await expect(page.getByLabel('正文', { exact: true })).toHaveValue('routing draft')
  await page.goForward()
  await expect(page).toHaveURL(/\/files$/)
  await expect(page.getByRole('region', { name: '服务器文件' })).toBeVisible()
  // 认证失效保留公共层中的草稿，重登仍回到当前文件页。
  await page.evaluate(() => fetch('/api/session', { method: 'DELETE' }))
  await page.getByRole('button', { name: '用户头像' }).click()
  await page.getByRole('button', { name: '检查登录状态' }).click()
  await expect(page).toHaveURL(/\/login\?next=%2Ffiles$/)
  await page.getByLabel('用户名').fill('Admin')
  await page.getByLabel('密码', { exact: true }).fill(' synthetic password ')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page).toHaveURL(/\/files$/)
  await page.getByRole('link', { name: '消息工作区', exact: true }).click()
  await expect(page.getByLabel('正文', { exact: true })).toHaveValue('routing draft')
  await page.getByLabel('正文', { exact: true }).fill('')
  await page.goto('/login?next=https://example.invalid')
  await expect(page).toHaveURL(new URL('/', process.env.TEST_BASE_URL!).href)
  await page.getByRole('link', { name: '服务器文件', exact: true }).click()
  await page.getByRole('button', { name: '用户头像' }).click()
  await page.getByRole('button', { name: '退出登录', exact: true }).click()
  await expect(page).toHaveURL(/\/login$/)
  await expect(page.getByLabel('用户名')).toBeVisible()
  await page.goBack()
  await expect(page.getByLabel('用户名')).toBeVisible()
  await expect(page.getByRole('region', { name: '消息流' })).toHaveCount(0)
})
