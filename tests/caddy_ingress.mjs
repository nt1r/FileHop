import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { once } from 'node:events'

const root = process.argv[2]
const ca = readFileSync(`${root}/cert.pem`)
const listen = async server => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port }
const observed = req => ({ authorization: req.headers.authorization ?? null, clientIp: req.headers['x-filehop-client-ip'] ?? null })
// 上游探针只验证反向代理的公开 HTTP 边界，不模拟应用认证或存储规则。
const upstream = http.createServer((req, res) => {
  if (req.url === '/api/file-sends/probe/attempts/probe/content') {
    let bytes = 0
    req.on('data', chunk => { bytes += chunk.length })
    req.on('end', () => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ bytes })) })
    return
  }
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(observed(req)))
})
upstream.on('upgrade', (req, socket) => {
  assert.equal(req.headers.authorization, undefined)
  socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
})
let child
try {
  const upstreamPort = await listen(upstream)
  const reserve = net.createServer()
  const port = await listen(reserve)
  await new Promise(resolve => reserve.close(resolve))
  const hash = spawnSync('caddy', ['hash-password'], { input: 'synthetic-ingress-password\n', encoding: 'utf8' })
  assert.equal(hash.status, 0)
  const config = `{
 admin off
 auto_https disable_redirects
 servers {
  protocols h1 h2
 }
}
https://localhost:${port} {
 bind 127.0.0.1
 tls ${root}/cert.pem ${root}/key.pem
 import ${process.cwd()}/deploy/caddy-dev.routes
}
`
  writeFileSync(`${root}/Caddyfile`, config)
  let logs = ''
  child = spawn('caddy', ['run', '--config', `${root}/Caddyfile`, '--adapter', 'caddyfile'], {
    env: { ...process.env, XDG_DATA_HOME: `${root}/data`, XDG_CONFIG_HOME: `${root}/config`, FILEHOP_DEV_USER: 'test', FILEHOP_DEV_PASSWORD_HASH: hash.stdout.trim(), FILEHOP_BACKEND_UPSTREAM: `127.0.0.1:${upstreamPort}`, FILEHOP_WEB_UPSTREAM: `127.0.0.1:${upstreamPort}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', b => { logs += b })
  child.stderr.on('data', b => { logs += b })
  const auth = `Basic ${Buffer.from('test:synthetic-ingress-password').toString('base64')}`
  const request = (path, headers = {}) => new Promise((resolve, reject) => {
    const req = https.get({ host: '127.0.0.1', port, path, ca, headers: { Host: `localhost:${port}`, ...headers }, timeout: 2000 }, res => {
      let body = ''; res.on('data', b => { body += b }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
    })
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve({ status: res.statusCode, headers: res.headers }) })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
  })
  const deadline = Date.now() + 10000
  while (true) {
    try { await request('/'); break } catch (error) {
      if (Date.now() >= deadline || child.exitCode !== null) throw new Error(`Caddy failed to start: ${logs}`, { cause: error })
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  for (const path of ['/', '/api/status', '/@vite/client', '/src/main.tsx']) {
    for (const authorization of [undefined, 'Basic d3Jvbmc6d3Jvbmc=']) {
      const res = await request(path, authorization ? { authorization } : {})
      assert.equal(res.status, 401, `${path}: ${JSON.stringify(res)}`)
      assert.equal(res.headers['x-filehop-access-layer'], 'development')
      assert.match(res.headers['www-authenticate'], /Basic/)
    }
    const res = await request(path, { authorization: auth, 'X-FileHop-Client-IP': '203.0.113.9' })
    assert.equal(res.status, 200)
    assert.equal(JSON.parse(res.body).authorization, null)
    if (path.startsWith('/api/')) assert.equal(JSON.parse(res.body).clientIp, '127.0.0.1')
  }
  assert.equal((await request('/internal/live', { authorization: auth })).status, 404)
  // 独立 HTTPS 入口不能沿用 JSON 请求的 15 秒整体期限；上游逐块接收文件体。
  const streamed = new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', port, path: '/api/file-sends/probe/attempts/probe/content',
      method: 'PUT', ca, headers: { Host: `localhost:${port}`, authorization: auth, Origin: `https://localhost:${port}` } }, res => {
      let body = ''; res.on('data', b => { body += b }); res.on('end', () => resolve({ status: res.statusCode, body }))
    })
    req.on('error', reject)
    req.write(Buffer.alloc(65536))
    setTimeout(() => { req.end(Buffer.alloc(65536)) }, 16000)
  })
  assert.deepEqual(await streamed, { status: 200, body: JSON.stringify({ bytes: 131072 }) })
  for (const path of ['/api/file-sends/probe/attempts/probe/content', '/api/files/probe']) {
    const res = await request(path)
    assert.equal(res.status, 401)
    assert.equal(res.headers['x-filehop-access-layer'], 'development')
  }
  const upgrade = { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' }
  assert.equal((await request('/', upgrade)).status, 401)
  assert.equal((await request('/', { ...upgrade, authorization: 'Basic d3Jvbmc6d3Jvbmc=' })).status, 401)
  assert.equal((await request('/', { ...upgrade, authorization: auth })).status, 101)
  console.log('HTTPS page/API/HMR/upgrade gate, credential removal, source override and internal route protection passed.')
} finally {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM')
    await once(child, 'exit')
  }
  upstream.closeAllConnections()
  await new Promise(resolve => upstream.close(resolve))
}
