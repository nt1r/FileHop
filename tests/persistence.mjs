import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';

// 只在一次性容器的网络命名空间内访问后端；不向宿主发布端口。
const phase = process.argv[2];
assert.ok(['seed', 'verify'].includes(phase));
const base = 'http://127.0.0.1:8080';
const payload = {
  send_id: '12345678-1234-4234-8234-123456789abc',
  text: '  synthetic container persistence\n第二行 <b>plain text</b>  ',
  source_label: 'Container test',
};
const deadline = Date.now() + 15000;
while (true) {
  try {
    const response = await fetch(`${base}/api/status`, { signal: AbortSignal.timeout(2000) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { state: 'initialized' });
    break;
  } catch (error) {
    if (Date.now() >= deadline) throw error;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
const request = async (path, status, cookie, body) => {
  const response = await fetch(base + path, {
    method: body ? 'POST' : 'GET',
    headers: {
      Origin: 'https://filehop.invalid',
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, status, path);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return response;
};
if (phase === 'seed') {
  const response = await request('/api/session', 200, null, {
    username: 'Admin', password: ' synthetic password ',
  });
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const session = await response.json();
  const message = await (await request('/api/messages', 201, cookie, payload)).json();
  for (const key of Object.keys(payload)) assert.equal(message[key], payload[key]);
  // 保存合成凭证只为验证原登录没有被重建撤销；文件不进入仓库或测试输出。
  await writeFile('/fixture/expected.json', JSON.stringify({ cookie, session, message }), { mode: 0o600 });
} else {
  const { cookie, session, message } = JSON.parse(await readFile('/fixture/expected.json', 'utf8'));
  const current = await (await request('/api/session', 200, cookie)).json();
  assert.equal(current.expires_at, session.expires_at);
  assert.deepEqual(await (await request(`/api/sends/${payload.send_id}`, 200, cookie)).json(), message);
  assert.deepEqual(await (await request('/api/messages', 200, cookie, payload)).json(), message);
  const history = await (await request('/api/messages', 200, cookie)).json();
  assert.deepEqual(history.messages, [message]);
  await request('/api/messages', 401);
}
console.log(`Container persistence ${phase} passed`);
