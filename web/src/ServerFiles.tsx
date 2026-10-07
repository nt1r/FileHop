import { useEffect, useRef, useState } from 'react'
import { ArrowClockwiseIcon, DownloadSimpleIcon, FileTextIcon } from '@phosphor-icons/react'
import { Badge } from '@cloudflare/kumo/components/badge'
import { Button } from '@cloudflare/kumo/components/button'
import { LayerCard } from '@cloudflare/kumo/components/layer-card'
import { Text } from '@cloudflare/kumo/components/text'
import { fileStateLabels, isMessage, type Message, type useMessages } from './messages'
import type { useFiles } from './files'
import StorageUsage from './StorageUsage'
import { useDeletion } from './deletion'
import DeleteFile from './DeleteFile'

type FileMessage = Extract<Message, { kind: 'FILE' }>

export default function ServerFiles({ files, exchange, onExpired }: { files: ReturnType<typeof useFiles>; exchange: ReturnType<typeof useMessages>; onExpired: () => void }) {
  const deletion = useDeletion(onExpired)
  const [usageRefresh, setUsageRefresh] = useState(0)
  const [items, setItems] = useState<FileMessage[]>([])
  const [before, setBefore] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const alive = useRef(false)
  const reading = useRef(false)
  const retryAt = useRef(0)
  const generation = useRef(0)
  async function load(older = false) {
    if (!alive.current || reading.current || document.visibilityState !== 'visible') return
    if (Date.now() < retryAt.current) { setNotice('请求过多，请稍后刷新。'); return }
    reading.current = true
    setBusy(true)
    setNotice('')
    const version = generation.current
    try {
      const response = await fetch(older ? `/api/files?before=${encodeURIComponent(before!)}` : '/api/files', {
        credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15000),
      })
      if (!alive.current || version !== generation.current) return
      const retry = response.headers.get('retry-after')
      if (retry) retryAt.current = /^\d+$/.test(retry) ? Date.now() + Number(retry) * 1000 : Date.parse(retry) || 0
      if (response.headers.has('x-filehop-access-layer') || !response.headers.get('content-type')?.includes('application/json')) throw new Error()
      const value = await response.json()
      if (!alive.current || version !== generation.current) return
      if (response.status === 401 && value?.code === 'session_invalid') { onExpired(); return }
      if (!response.ok || !value || !Array.isArray(value.files) || value.files.length > 50 ||
        !value.files.every((m: unknown) => isMessage(m) && m.kind === 'FILE') || typeof value.has_more !== 'boolean') throw new Error()
      const page = value.files as FileMessage[]
      if (value.before !== (page.at(-1)?.id ?? null) || (value.has_more && !page.length) ||
        page.some((m, i) => (older && before !== null && BigInt(m.id) >= BigInt(before)) || (i > 0 && BigInt(m.id) >= BigInt(page[i - 1].id)))) throw new Error()
      exchange.rememberFiles(page)
      setItems(current => older ? [...current, ...page] : page)
      if (!older) await exchange.refreshFileStates()
      if (!alive.current || version !== generation.current) return
      setBefore(value.before)
      setHasMore(value.has_more)
    } catch {
      if (alive.current && version === generation.current) setNotice('读取文件列表失败，请检查网络或访问层后刷新。')
    } finally {
      if (alive.current && version === generation.current) { reading.current = false; setBusy(false) }
    }
  }
  useEffect(() => {
    alive.current = true
    void load()
    const visible = () => { if (document.visibilityState === 'visible') queueMicrotask(() => void load()) }
    document.addEventListener('visibilitychange', visible)
    // 切页或认证界面卸载后立即废弃读取；旧认证周期的成功或失败都不能更新新界面。
    const invalidate = () => { alive.current = false; generation.current++; reading.current = false }
    return () => { invalidate(); document.removeEventListener('visibilitychange', visible) }
    // 页面进入时刷新，输入和上传变化不重启读取。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  async function download(id: string) {
    const version = generation.current
    const message = await files.download(id)
    if (alive.current && version === generation.current) setNotice(message)
  }
  return <section className="stream" aria-label="服务器文件">
    <LayerCard className="panel server-files-panel">
      <div className="panel-heading">
        <div>
          <Text variant="heading3" as="h2">服务器文件</Text>
          <Text variant="secondary" size="sm">按成功上传顺序展示；仅管理经 FileHop 提交的文件。</Text>
        </div>
        <Button variant="secondary" icon={<ArrowClockwiseIcon />} disabled={busy} onClick={() => { void load(); setUsageRefresh(value => value + 1) }}>刷新文件列表</Button>
      </div>
      <StorageUsage refresh={usageRefresh} onExpired={onExpired} />
      {notice && <Text role="status" variant="error">{notice}</Text>}
      {exchange.fileStatusNotice && <Text role="status" variant="error">{exchange.fileStatusNotice}</Text>}
      {busy && <Text role="status">正在读取文件列表…</Text>}
      {!busy && !notice && items.length === 0 && <Text variant="secondary">暂无服务器文件。</Text>}
      {items.map(exchange.projectFile).filter(file => file.file_state !== 'deleted').map(file => <LayerCard key={file.file_id} className="message server-file-item" render={<article />}>
        <div className="server-file-card-content">
          <div className="server-file-icon-box">
            <FileTextIcon size={26} weight="duotone" className="text-brand" />
          </div>
          <div className="server-file-info">
            <Text variant="heading" as="h3">{file.file_name}</Text>
            <div className="server-file-meta-row">
              <Text>{file.file_size.toLocaleString('zh-CN')} 字节 · {file.source_label}</Text>
              <Text as="time" {...{ dateTime: file.created_at }}>上传时间：{file.created_at}</Text>
            </div>
            <div className="server-file-state-row">
              <Badge variant={file.file_state === 'available' ? 'success' : file.file_state === 'storage_error' ? 'error' : 'warning'}>
                {fileStateLabels[file.file_state]}
              </Badge>
            </div>
          </div>
          <div className="server-file-actions-row">
            {file.file_state === 'available' && !deletion.blocksDownload(file.file_id) && <a href={`/api/files/${encodeURIComponent(file.file_id)}`} download className="server-file-download-btn" onClick={event => { event.preventDefault(); void download(file.file_id) }}><DownloadSimpleIcon size={15} /><span>下载附件</span></a>}
            <DeleteFile file={file} deletion={deletion} />
          </div>
        </div>
      </LayerCard>)}
      {hasMore && <div className="load-more-row"><Button variant="secondary" disabled={busy} onClick={() => void load(true)}>加载更多文件</Button></div>}
    </LayerCard>
  </section>
}
