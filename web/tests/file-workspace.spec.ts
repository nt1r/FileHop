import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

test('files workspace supports local search, category filters and upload feedback', async ({ page }) => {
  execFileSync('cargo', ['test', '--manifest-path', resolve('../backend/Cargo.toml'), '--locked', '--test', 'initialization', 'initialize_external_fixture', '--', '--ignored', '--exact'], {
    timeout: 120_000,
    env: { ...process.env, FILEHOP_FIXTURE_COMMAND: resolve('../backend/target/debug/backend'),
      FILEHOP_FIXTURE_ARGS: JSON.stringify(['--database-dir', process.env.TEST_DATABASE!, '--files-dir', process.env.TEST_FILES!, 'init', '--username', 'Admin', '--confirm-paths']) },
  })
  await page.goto('/files')
  await page.getByLabel('用户名').fill('Admin')
  await page.getByLabel('密码', { exact: true }).fill(' synthetic password ')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  const listing = page.getByRole('region', { name: '服务器文件', exact: true })
  const rows = listing.getByRole('article')
  const tasks = listing.getByRole('region', { name: '文件上传任务' })
  await expect(listing.getByRole('button', { name: '上传文件', exact: true })).toBeEnabled()
  // 真实系统选择入口，四种类型均用合成内容；文件类型仅按扩展名分类。
  const chooser = page.waitForEvent('filechooser')
  await listing.getByRole('button', { name: '上传文件', exact: true }).click()
  await (await chooser).setFiles(['Report.PDF', 'photo.png', 'clip.mp4', 'archive.zip'].map(name => ({ name, mimeType: 'application/octet-stream', buffer: Buffer.from('sample') })))
  await expect(tasks.getByText('上传成功', { exact: true })).toHaveCount(4)
  await expect(tasks.getByRole('progressbar')).toHaveCount(4)
  await listing.getByRole('button', { name: '刷新文件列表' }).click()
  await expect(rows).toHaveCount(4)
  await expect(listing.getByText('按上传时间从新到旧', { exact: true })).toBeVisible()
  await expect(listing.getByText(/分类数量、搜索和筛选仅针对已加载文件/)).toBeVisible()

  await listing.getByRole('button', { name: '搜索文件', exact: true }).click()
  const search = listing.getByRole('searchbox', { name: '搜索已加载文件名' })
  await search.fill(' report ')
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText('Report.PDF')
  const images = listing.getByRole('button', { name: '图片 1 项', exact: true })
  await images.click()
  await expect(images).toHaveAttribute('aria-pressed', 'true')
  await expect(rows).toHaveCount(0)
  await expect(listing.getByText('已加载文件中没有匹配项。')).toBeVisible()
  await search.fill('')
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText('photo.png')
  await images.click()
  await expect(rows).toHaveCount(4)
  await search.fill('missing')
  await expect(rows).toHaveCount(0)
  await listing.getByRole('button', { name: '搜索文件', exact: true }).click()
  await expect(rows).toHaveCount(4)

  // 文件限制错误直接在文件页可见，不要求切回对话页。
  await listing.getByLabel('选择要上传的文件').setInputFiles({ name: 'too-large.txt', mimeType: 'text/plain', buffer: Buffer.alloc(1025) })
  await expect(tasks).toContainText('文件超过服务器单文件上限')
  page.once('dialog', dialog => dialog.accept())
  await tasks.getByRole('button', { name: '结束本轮' }).click()
  await expect(tasks).toHaveCount(0)

  // 仅拦住一次内容请求以使中断入口可观察；不 Mock 上传成功或存储。
  let arrived!: () => void
  let release!: () => void
  const received = new Promise<void>(resolve => { arrived = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/file-sends/*/attempts/*/content', async route => {
    arrived()
    await held
    await route.abort()
  })
  await listing.getByLabel('选择要上传的文件').setInputFiles({ name: 'interrupt.txt', mimeType: 'text/plain', buffer: Buffer.from('test') })
  try {
    await received
    await expect(tasks.getByRole('progressbar', { name: 'interrupt.txt 上传进度' })).toBeVisible()
    await tasks.getByRole('button', { name: '中断传输' }).click()
    await expect(tasks).toContainText('结果未确认')
    await expect(tasks.getByRole('button', { name: '查询文件结果' })).toBeEnabled()
    page.once('dialog', dialog => dialog.accept())
    await tasks.getByRole('button', { name: '结束本轮' }).click()
    await expect(tasks).toHaveCount(0)
  } finally {
    release()
    await page.unrouteAll({ behavior: 'wait' })
  }
  await page.getByRole('link', { name: '消息工作区' }).click()
  await expect(page.getByRole('heading', { name: '消息流', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: '在线', exact: true })).toHaveCount(0)
})
