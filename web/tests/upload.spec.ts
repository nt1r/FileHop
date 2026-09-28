import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { verifyQueueRecovery } from './files'

test('unknown uploads pause until manual query or explicit batch end', async ({ page }) => {
  test.setTimeout(120_000)
  execFileSync('cargo', ['test', '--manifest-path', resolve('../backend/Cargo.toml'), '--locked', '--test', 'initialization', 'initialize_external_fixture', '--', '--ignored', '--exact'], {
    timeout: 120_000,
    env: { ...process.env, FILEHOP_FIXTURE_COMMAND: resolve('../backend/target/debug/backend'),
      FILEHOP_FIXTURE_ARGS: JSON.stringify(['--database-dir', process.env.TEST_DATABASE!, '--files-dir', process.env.TEST_FILES!, 'init', '--username', 'Admin', '--confirm-paths']) },
  })
  await page.clock.install()
  await page.goto('/')
  await page.getByLabel('用户名').fill('Admin')
  await page.getByLabel('密码', { exact: true }).fill(' synthetic password ')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByRole('region', { name: '消息流' })).toBeVisible()
  await expect(page.getByRole('button', { name: '选择文件' })).toBeEnabled()
  await verifyQueueRecovery(page)
})
