// Regenerate platform assets from the tracked PNG; no model call or private input.
// Requires the existing Web dev dependencies and Playwright Chromium.
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const require = createRequire(new URL('../web/package.json', import.meta.url))
const { chromium } = require('@playwright/test')
const root = new URL('../', import.meta.url)
const source = await readFile(new URL('assets/branding/filehop-logo-source.png', root))
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage()
  const images = await page.evaluate(async data => {
    const image = new Image()
    image.src = `data:image/png;base64,${data}`
    await image.decode()
    const sourceCanvas = document.createElement('canvas')
    sourceCanvas.width = image.width; sourceCanvas.height = image.height
    const sourceContext = sourceCanvas.getContext('2d')
    sourceContext.drawImage(image, 0, 0)
    const pixels = sourceContext.getImageData(0, 0, image.width, image.height).data
    let left = image.width, top = image.height, right = 0, bottom = 0
    // Ignore almost-transparent pixels only when measuring the artwork's bounds.
    for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
      if (pixels[(y * image.width + x) * 4 + 3] <= 16) continue
      left = Math.min(left, x); right = Math.max(right, x + 1)
      top = Math.min(top, y); bottom = Math.max(bottom, y + 1)
    }
    const width = right - left, height = bottom - top
    if (width <= 0 || height <= 0) throw new Error('Logo has no visible pixels')
    let radius = 0
    for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
      if (pixels[(y * image.width + x) * 4 + 3] <= 16) continue
      radius = Math.max(radius, Math.hypot(x + 0.5 - (left + right) / 2, y + 0.5 - (top + bottom) / 2))
    }
    const render = (size, adaptive = false, monochrome = false, background = false) => {
      const canvas = document.createElement('canvas')
      canvas.width = size; canvas.height = size
      const context = canvas.getContext('2d')
      if (background) { context.fillStyle = '#F4F9F8'; context.fillRect(0, 0, size, size) }
      // Adaptive artwork fits inside radius 31.32/108, within the 66dp safe circle.
      const scale = adaptive ? size * 0.29 / radius : size * 0.90 / Math.max(width, height)
      context.drawImage(image, left, top, width, height,
        (size - width * scale) / 2, (size - height * scale) / 2, width * scale, height * scale)
      if (monochrome) {
        context.globalCompositeOperation = 'source-in'
        context.fillStyle = '#000000'; context.fillRect(0, 0, size, size)
      }
      return canvas.toDataURL('image/png').split(',')[1]
    }
    return {
      logo: render(256), foreground: render(432, true), monochrome: render(432, true, true),
      favicons: [16, 32, 48].map(size => ({ size, data: render(size, false, false, true) })),
    }
  }, source.toString('base64'))
  const save = async (path, bytes) => {
    const url = new URL(path, root)
    await mkdir(fileURLToPath(new URL('./', url)), { recursive: true })
    await writeFile(url, bytes)
  }
  const logo = Buffer.from(images.logo, 'base64')
  await save('web/src/assets/filehop-logo.png', logo)
  await save('android/app/src/main/res/drawable-nodpi/filehop_logo.png', logo)
  await save('android/app/src/main/res/drawable-nodpi/ic_launcher_foreground.png', Buffer.from(images.foreground, 'base64'))
  await save('android/app/src/main/res/drawable-nodpi/ic_launcher_monochrome.png', Buffer.from(images.monochrome, 'base64'))
  // ICO with PNG frames; browsers choose the closest size without loading the master.
  const frames = images.favicons.map(({ data }) => Buffer.from(data, 'base64'))
  const header = Buffer.alloc(6 + 16 * frames.length)
  header.writeUInt16LE(1, 2); header.writeUInt16LE(frames.length, 4)
  let offset = header.length
  frames.forEach((frame, i) => {
    const pos = 6 + i * 16
    header[pos] = images.favicons[i].size; header[pos + 1] = images.favicons[i].size
    header.writeUInt16LE(1, pos + 4); header.writeUInt16LE(32, pos + 6)
    header.writeUInt32LE(frame.length, pos + 8); header.writeUInt32LE(offset, pos + 12)
    offset += frame.length
  })
  await save('web/src/assets/favicon.ico', Buffer.concat([header, ...frames]))
  console.log('Generated Web and Android brand assets; source PNG unchanged.')
} finally {
  await browser.close()
}
