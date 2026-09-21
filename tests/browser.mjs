// Minimal browser fixture: static build + real backend on loopback random ports.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve, extname, sep } from 'node:path'
import { spawn } from 'node:child_process'

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
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const headers = { ...request.headers }
      // 一次性回环测试代理：只映射本测试站点的 Origin，错误来源原样交给后端拒绝。
      if (headers.origin === `http://localhost:${server.address().port}`) headers.origin = 'https://filehop.invalid'
      delete headers.host
      delete headers['content-length']
      const upstream = await fetch(backend + request.url, {
        method: request.method, headers,
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
        signal: AbortSignal.timeout(30000),
      })
      response.writeHead(upstream.status, Object.fromEntries(upstream.headers))
      response.end(Buffer.from(await upstream.arrayBuffer()))
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
const child = spawn('pnpm', ['-C', 'web', 'run', 'test:e2e'], {
  stdio: 'inherit', env: { ...process.env, TEST_BASE_URL: `http://localhost:${server.address().port}` },
})
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal))
const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)) })
server.closeAllConnections()
await new Promise(resolve => server.close(resolve))
process.exitCode = code
