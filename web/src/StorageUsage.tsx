import { useEffect, useRef, useState } from 'react'
import { Text } from '@cloudflare/kumo/components/text'

type Usage = { quota_bytes: string; saved_bytes: string; reserved_bytes: string; cleaning_bytes: string; available_bytes: string; over_quota: boolean }
const fields = ['quota_bytes', 'saved_bytes', 'reserved_bytes', 'cleaning_bytes', 'available_bytes'] as const
function isUsage(value: unknown): value is Usage {
  if (!value || typeof value !== 'object') return false
  const usage = value as Usage
  if (!fields.every(key => typeof usage[key] === 'string' && /^(0|[1-9]\d{0,18})$/.test(usage[key])) || typeof usage.over_quota !== 'boolean') return false
  const used = BigInt(usage.saved_bytes) + BigInt(usage.reserved_bytes) + BigInt(usage.cleaning_bytes)
  const remaining = BigInt(usage.quota_bytes) - used
  return BigInt(usage.available_bytes) === (remaining > 0n ? remaining : 0n) && usage.over_quota === (remaining < 0n)
}

export default function StorageUsage({ refresh, onExpired }: { refresh: number; onExpired: () => void }) {
  const [usage, setUsage] = useState<Usage | null>(null)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const retryAt = useRef(0)
  const expired = useRef(onExpired)
  useEffect(() => { expired.current = onExpired }, [onExpired])
  useEffect(() => {
    let alive = true
    let generation = 0
    async function load() {
      if (document.visibilityState !== 'visible') return
      // 容量没有全局文件版本；每次刷新都使旧请求失效，即使旧响应更晚到达也不能覆盖新快照。
      const version = ++generation
      if (Date.now() < retryAt.current) { setBusy(false); setNotice('请求过多，请稍后刷新用量。'); return }
      setBusy(true)
      setNotice('')
      try {
        const response = await fetch('/api/storage', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15000) })
        if (!alive || version !== generation) return
        const retry = response.headers.get('retry-after')
        if (retry) retryAt.current = /^\d+$/.test(retry) ? Date.now() + Number(retry) * 1000 : Date.parse(retry) || 0
        if (response.headers.has('x-filehop-access-layer') || !response.headers.get('content-type')?.includes('application/json')) throw Error()
        const value: unknown = await response.json()
        if (!alive || version !== generation) return
        if (response.status === 401 && value && typeof value === 'object' && 'code' in value && value.code === 'session_invalid') { expired.current(); return }
        if (!response.ok || !isUsage(value)) throw Error()
        setUsage(value)
      } catch {
        if (alive && version === generation) setNotice('读取用量失败，请检查网络或访问层后刷新；已有数值仅为上次快照。')
      } finally {
        if (alive && version === generation) setBusy(false)
      }
    }
    void load()
    const visible = () => { if (document.visibilityState === 'visible') void load() }
    document.addEventListener('visibilitychange', visible)
    // 切页、认证失效或退出均卸载面板。旧认证周期的响应不得重新展示私人用量。
    return () => { alive = false; generation++; document.removeEventListener('visibilitychange', visible) }
  }, [refresh])
  const bytes = (value: string) => `${BigInt(value).toLocaleString('zh-CN')} 字节`
  return <section aria-label="应用文件额度" className="storage-usage">
    <Text variant="heading3" as="h3">应用文件额度</Text>
    <Text variant="secondary" size="sm">不是整台服务器磁盘用量；实际磁盘不足由具体操作单独提示。用量是快照，上传仍由服务器原子检查准入。</Text>
    {busy && <Text role="status">正在读取用量…</Text>}
    {notice && <Text role="status" variant="error">{notice}</Text>}
    {usage && <>
      <dl className="storage-values">
        <div><dt>总额度：</dt><dd>{bytes(usage.quota_bytes)}</dd></div>
        <div><dt>已保存文件：</dt><dd>{bytes(usage.saved_bytes)}</dd></div>
        <div><dt>上传预留：</dt><dd>{bytes(usage.reserved_bytes)}</dd></div>
        <div><dt>待清理占用：</dt><dd>{bytes(usage.cleaning_bytes)}</dd></div>
        <div><dt>可用额度：</dt><dd>{bytes(usage.available_bytes)}</dd></div>
      </dl>
      {usage.over_quota && <Text role="status" variant="error">当前占用已超过配置额度，可用额度为 0；不会自动删除文件。</Text>}
    </>}
    <Text variant="secondary" size="sm">上传预留包含活动上传的全部大小及临时数据；失败残留在清理完成前仍占额度。</Text>
  </section>
}
