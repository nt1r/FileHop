import { expect, type Page } from '@playwright/test'

// 推进既有前台轮询时钟，仍通过真实 HTTP 读取，不调用应用内部函数。
export async function pollMessages(page: Page) {
  const response = page.waitForResponse(response => response.request().method() === 'GET' &&
    new URL(response.url()).pathname === '/api/messages' && new URL(response.url()).searchParams.has('after'))
  await page.clock.runFor(10000)
  await (await response).finished()
  await expect(page.getByLabel('消息历史', { exact: true })).toHaveAttribute('aria-busy', 'false')
}

export async function visibility(page: Page, state: 'hidden' | 'visible') {
  await page.evaluate(state => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
    document.dispatchEvent(new Event('visibilitychange'))
  }, state)
}
