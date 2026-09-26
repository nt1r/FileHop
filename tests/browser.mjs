// Minimal browser fixture: static build + real backend on loopback random ports.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve, extname, sep } from 'node:path'
import { spawn } from 'node:child_process'
import { Readable } from 'node:stream'

const deadline = Date.now() + 15000
let backend
while (Date.now() < deadline) {
  const log = await readFile(process.env.TEST_BACKEND_LOG, 'utf8')
  const match = log.match(/^listening=(.+)$/m)
  if (match) { backend = `http://${match[1]}`; break }
  await new Promise(resolve => setTimeout(resolve, 50))
}
if (!backend) throw new Error('Backend startup timed out')
const root = resolve('web/dist')
const server = createServer(async (request, response) => {
  try {
    if (request.url.startsWith('/api/')) {
      const headers = { ...request.headers }
      // 回环代理只映射本站 Origin；文件体与响应逐块转发，不能用测试代理的内存缓冲掩盖真实流式边界。
      if (headers.origin === `http://localhost:${server.address().port}`) headers.origin = 'https://filehop.invalid'
      delete headers.host
      const transfer = request.url.includes('/api/files/') || request.url.includes('/api/file-sends/')
      const upstream = await fetch(backend + request.url, {
        method: request.method, headers,
        ...(['POST', 'PUT'].includes(request.method) ? { body: request, duplex: 'half' } : {}),
        signal: AbortSignal.timeout(transfer ? 31 * 60 * 1000 : 30000),
      })
      response.writeHead(upstream.status, Object.fromEntries(upstream.headers))
      if (upstream.body && request.method !== 'HEAD') Readable.fromWeb(upstream.body).pipe(response)
      else response.end()
    } else {
      const path = resolve(root, '.' + (request.url === '/' ? '/index.html' : new URL(request.url, 'http://localhost').pathname))
      if (!path.startsWith(root + sep)) { response.writeHead(403); response.end(); return }
      const body = await readFile(path)
      response.setHeader('content-type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[extname(path)] || 'application/octet-stream')
      response.end(body)
    }
  } catch { response.writeHead(502); response.end() }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const child = spawn('pnpm', ['-C', 'web', 'run', 'test:e2e', process.env.TEST_SPEC], {
  stdio: 'inherit', env: { ...process.env, TEST_BASE_URL: `http://localhost:${server.address().port}` },
})
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal))
const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)) })
server.closeAllConnections()
await new Promise(resolve => server.close(resolve))
process.exitCode = code
