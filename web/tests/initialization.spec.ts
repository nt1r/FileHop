import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

test('administrator initializes storage and the page observes the real status', async ({ page }) => {
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
  writeFileSync(resolve(process.env.TEST_FILES!, 'storage-id'), 'mismatched')
  await page.getByRole('button', { name: '刷新状态' }).click()
  await expect(page.getByRole('status')).toContainText('存储异常')
  await page.route('**/api/status', route => route.fulfill({ status: 401, contentType: 'text/html', body: 'Access gate' }))
  await page.getByRole('button', { name: '刷新状态' }).click()
  await expect(page.getByRole('status')).toContainText('无法获取应用状态')
})
