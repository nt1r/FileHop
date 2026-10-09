import { useEffect, useRef, useState } from 'react'
import {
  ArrowClockwiseIcon,
  CloudArrowUpIcon,
  CloudIcon,
  DownloadSimpleIcon,
  FolderIcon,
  MagnifyingGlassIcon,
  PlusIcon,
} from '@phosphor-icons/react'
import { Badge } from '@cloudflare/kumo/components/badge'
import { Button } from '@cloudflare/kumo/components/button'
import { LayerCard } from '@cloudflare/kumo/components/layer-card'
import { Text } from '@cloudflare/kumo/components/text'
import { fileStateLabels, isMessage, validLabel, type Message, type useMessages } from './messages'
import type { useFiles } from './files'
import StorageUsage from './StorageUsage'
import { useDeletion } from './deletion'
import DeleteFile from './DeleteFile'
import { formatBytes, formatMessageTime, getFileCategory, type FileCategory } from './format'
import { FileTypeBadge } from './ui'
import UploadTasks from './UploadTasks'

type FileMessage = Extract<Message, { kind: 'FILE' }>

export default function ServerFiles({ files, exchange, onExpired }: { files: ReturnType<typeof useFiles>; exchange: ReturnType<typeof useMessages>; onExpired: () => void }) {
  const deletion = useDeletion(onExpired)
  const [usageRefresh, setUsageRefresh] = useState(0)
  const [items, setItems] = useState<FileMessage[]>([])
  const [before, setBefore] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [selectedCategory, setSelectedCategory] = useState<FileCategory | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [dragging, setDragging] = useState(false)

  const uploadInputRef = useRef<HTMLInputElement>(null)
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
    const invalidate = () => { alive.current = false; generation.current++; reading.current = false }
    return () => { invalidate(); document.removeEventListener('visibilitychange', visible) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function download(id: string) {
    const version = generation.current
    const message = await files.download(id)
    if (alive.current && version === generation.current) setNotice(message)
  }

  const canChooseFiles = typeof files.limits === 'number' && validLabel(exchange.label)

  function handleFileSelection(selectedFiles: File[]) {
    if (!canChooseFiles || !selectedFiles.length) return
    void files.choose(selectedFiles, exchange.label)
  }

  const activeFiles = items.map(exchange.projectFile).filter(file => file.file_state !== 'deleted')

  const categoryCounts = {
    document: 0,
    image: 0,
    video: 0,
    other: 0,
  }
  for (const file of activeFiles) {
    const cat = getFileCategory(file.file_name)
    categoryCounts[cat]++
  }

  const filteredFiles = activeFiles.filter(file => {
    if (selectedCategory && getFileCategory(file.file_name) !== selectedCategory) {
      return false
    }
    if (searchQuery.trim() && !file.file_name.toLowerCase().includes(searchQuery.trim().toLowerCase())) {
      return false
    }
    return true
  })

  return (
    <section className="stream" aria-label="服务器文件">
      {/* Hidden file input for uploads */}
      <input
        ref={uploadInputRef}
        type="file"
        multiple
        aria-label="选择要上传的文件"
        disabled={!canChooseFiles}
        className="file-picker"
        style={{ display: 'none' }}
        onChange={e => {
          const selected = Array.from(e.target.files || [])
          e.target.value = ''
          handleFileSelection(selected)
        }}
      />

      <LayerCard className="panel server-files-panel">
        {/* Header Section matching mockup */}
        <div className="server-files-hero-header">
          <div className="server-files-hero-left">
            <div className="server-files-cloud-emblem">
              <CloudIcon size={32} weight="duotone" />
            </div>
            <div className="server-files-hero-titles">
              <Text variant="heading" as="h2" DANGEROUS_className="server-files-main-title">
                服务器文件
              </Text>
              <Text variant="secondary" size="sm" DANGEROUS_className="server-files-main-subtitle">
                查看、下载和清理已上传的文件
              </Text>
            </div>
          </div>

          <div className="server-files-hero-tools">
            <button
              type="button"
              className="server-tool-btn"
              aria-label="搜索文件"
              title="搜索文件"
              aria-expanded={searchOpen}
              aria-controls="server-files-search"
              onClick={() => {
                if (searchOpen) setSearchQuery('')
                setSearchOpen(prev => !prev)
              }}
            >
              <MagnifyingGlassIcon size={18} />
            </button>
            <button
              type="button"
              className="server-plus-btn"
              aria-label="上传文件"
              title="上传文件"
              disabled={!canChooseFiles}
              onClick={() => uploadInputRef.current?.click()}
            >
              <PlusIcon size={20} weight="bold" />
            </button>
            <Button
              variant="secondary"
              size="sm"
              icon={<ArrowClockwiseIcon />}
              disabled={busy}
              onClick={() => { void load(); setUsageRefresh(v => v + 1) }}
            >
              刷新文件列表
            </Button>
          </div>
        </div>

        {/* Search bar when toggled */}
        {searchOpen && (
          <div className="server-files-search-row">
            <input
              type="search"
              id="server-files-search"
              aria-label="搜索已加载文件名"
              placeholder="搜索已加载文件名..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="server-files-search-input"
              autoFocus
            />
          </div>
        )}

        {/* 4 Category Folder Cards matching mockup */}
        <div className="server-category-grid">
          <button
            type="button"
            aria-pressed={selectedCategory === 'document'}
            className={`server-category-card ${selectedCategory === 'document' ? 'selected' : ''}`}
            onClick={() => setSelectedCategory(prev => prev === 'document' ? null : 'document')}
          >
            <div className="category-card-icon">
              <FolderIcon size={44} weight="fill" className="text-folder-blue" />
            </div>
            <div className="category-card-label">文档</div>
            <div className="category-card-count">{categoryCounts.document} 项</div>
          </button>

          <button
            type="button"
            aria-pressed={selectedCategory === 'image'}
            className={`server-category-card ${selectedCategory === 'image' ? 'selected' : ''}`}
            onClick={() => setSelectedCategory(prev => prev === 'image' ? null : 'image')}
          >
            <div className="category-card-icon">
              <FolderIcon size={44} weight="fill" className="text-folder-blue" />
            </div>
            <div className="category-card-label">图片</div>
            <div className="category-card-count">{categoryCounts.image} 项</div>
          </button>

          <button
            type="button"
            aria-pressed={selectedCategory === 'video'}
            className={`server-category-card ${selectedCategory === 'video' ? 'selected' : ''}`}
            onClick={() => setSelectedCategory(prev => prev === 'video' ? null : 'video')}
          >
            <div className="category-card-icon">
              <FolderIcon size={44} weight="fill" className="text-folder-blue" />
            </div>
            <div className="category-card-label">视频</div>
            <div className="category-card-count">{categoryCounts.video} 项</div>
          </button>

          <button
            type="button"
            aria-pressed={selectedCategory === 'other'}
            className={`server-category-card ${selectedCategory === 'other' ? 'selected' : ''}`}
            onClick={() => setSelectedCategory(prev => prev === 'other' ? null : 'other')}
          >
            <div className="category-card-icon">
              <FolderIcon size={44} weight="fill" className="text-folder-blue" />
            </div>
            <div className="category-card-label">其他</div>
            <div className="category-card-count">{categoryCounts.other} 项</div>
          </button>
        </div>

        <Text variant="secondary" size="sm">
          分类数量、搜索和筛选仅针对已加载文件；再次点击分类可取消筛选。
        </Text>

        <UploadTasks files={files} />

        {/* Storage Quota Section */}
        <StorageUsage refresh={usageRefresh} onExpired={onExpired} />

        {notice && <Text role="status" variant="error">{notice}</Text>}
        {exchange.fileStatusNotice && <Text role="status" variant="error">{exchange.fileStatusNotice}</Text>}
        {busy && <Text role="status">正在读取文件列表…</Text>}

        {/* Recent Files Section */}
        <div className="server-recent-section">
          <div className="server-recent-header">
            <Text variant="heading" as="h3" DANGEROUS_className="server-recent-title">
              最近文件
            </Text>
            <div className="server-recent-sort">
              <span>按上传时间从新到旧</span>
            </div>
          </div>

          {!busy && !notice && filteredFiles.length === 0 && (
            <div className="server-empty-state">
              <Text variant="secondary">
                {selectedCategory || searchQuery ? '已加载文件中没有匹配项。' : '暂无服务器文件。'}
              </Text>
            </div>
          )}

          <div className="server-file-list">
            {filteredFiles.map(file => (
              <LayerCard
                key={file.file_id}
                className="message server-file-item"
                render={<article />}
              >
                <div className="server-file-card-content">
                  <div className="server-file-badge-wrapper">
                    <FileTypeBadge filename={file.file_name} size="md" />
                  </div>

                  <div className="server-file-info">
                    <Text variant="heading" as="h4" DANGEROUS_className="server-file-name">
                      {file.file_name}
                    </Text>
                    <div className="server-file-meta-row">
                      <span className="server-file-meta-size">{formatBytes(file.file_size)}</span>
                      <span className="server-file-meta-dot">·</span>
                      <time className="server-file-meta-time" dateTime={file.created_at}>
                        {formatMessageTime(file.created_at)}
                      </time>
                      <span className="server-file-meta-dot">·</span>
                      <span className="server-file-meta-source">{file.source_label}</span>
                    </div>
                  </div>

                  <div className="server-file-actions-row">
                    <div className="server-file-state-row">
                      <Badge variant={file.file_state === 'available' ? 'success' : file.file_state === 'storage_error' ? 'error' : 'warning'}>
                        {fileStateLabels[file.file_state]}
                      </Badge>
                    </div>

                    {file.file_state === 'available' && !deletion.blocksDownload(file.file_id) && (
                      <a
                        href={`/api/files/${encodeURIComponent(file.file_id)}`}
                        download
                        className="server-file-download-btn"
                        onClick={event => { event.preventDefault(); void download(file.file_id) }}
                      >
                        <DownloadSimpleIcon size={15} />
                        <span>下载附件</span>
                      </a>
                    )}

                    <DeleteFile file={file} deletion={deletion} />
                  </div>
                </div>
              </LayerCard>
            ))}
          </div>

          {hasMore && (
            <div className="load-more-row">
              <Button variant="secondary" disabled={busy} onClick={() => void load(true)}>
                加载更多文件
              </Button>
            </div>
          )}
        </div>

        {/* Bottom Upload Dropzone matching mockup */}
        <div
          className={`server-dropzone-box ${dragging ? 'dragging' : ''}`}
          role="button"
          tabIndex={canChooseFiles ? 0 : -1}
          aria-disabled={!canChooseFiles}
          aria-label="拖拽或点击上传文件"
          onClick={() => { if (canChooseFiles) uploadInputRef.current?.click() }}
          onKeyDown={e => {
            if (canChooseFiles && (e.key === 'Enter' || e.key === ' ')) {
              e.preventDefault()
              uploadInputRef.current?.click()
            }
          }}
          onDragOver={e => {
            e.preventDefault()
            if (canChooseFiles) setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={e => {
            e.preventDefault()
            setDragging(false)
            const dropped = Array.from(e.dataTransfer.files)
            handleFileSelection(dropped)
          }}
        >
          <div className="dropzone-icon-circle">
            <CloudArrowUpIcon size={28} weight="bold" />
          </div>
          <div className="dropzone-text-group">
            <span className="dropzone-prompt-text">
              点击按钮选择文件，或将文件拖拽到此处
            </span>
            <span className="dropzone-sub-text">
              支持任意格式的文件上传
            </span>
          </div>
        </div>
      </LayerCard>
    </section>
  )
}
