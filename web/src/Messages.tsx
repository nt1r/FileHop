import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  ArrowClockwiseIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  CopyIcon,
  DesktopIcon,
  DownloadSimpleIcon,
  PaperPlaneTiltIcon,
  PaperclipIcon,
} from '@phosphor-icons/react'
import { Badge } from '@cloudflare/kumo/components/badge'
import { Button } from '@cloudflare/kumo/components/button'
import { Textarea } from '@cloudflare/kumo/components/input'
import { LayerCard } from '@cloudflare/kumo/components/layer-card'
import { Text } from '@cloudflare/kumo/components/text'
import { fileStateLabels, type useMessages, validLabel, validText } from './messages'
import { type useFiles } from './files'
import { formatBytes, formatMessageDate, formatMessageTime } from './format'
import { FileTypeBadge, UserAvatar } from './ui'

const DEVICE_PALETTES = [
  { text: '#0284c7', bg: '#f0f9ff', border: '#bae6fd', badgeBg: '#e0f2fe' },
  { text: '#b45309', bg: '#fffbeb', border: '#fde68a', badgeBg: '#fef3c7' },
  { text: '#7c3aed', bg: '#faf5ff', border: '#e9d5ff', badgeBg: '#f3e8ff' },
  { text: '#0f766e', bg: '#f0fdfa', border: '#99f6e4', badgeBg: '#ccfbf1' },
  { text: '#be123c', bg: '#fff1f2', border: '#fecdd3', badgeBg: '#ffe4e6' },
  { text: '#c2410c', bg: '#fff7ed', border: '#fed7aa', badgeBg: '#ffedd5' },
  { text: '#4338ca', bg: '#eef2ff', border: '#c7d2fe', badgeBg: '#e0e7ff' },
  { text: '#0e7490', bg: '#ecfeff', border: '#a5f3fc', badgeBg: '#cffafe' },
]

function getDevicePalette(source: string) {
  let hash = 0
  for (let i = 0; i < source.length; i++) hash = (hash * 31 + source.charCodeAt(i)) >>> 0
  return DEVICE_PALETTES[hash % DEVICE_PALETTES.length]
}

export default function Messages({ exchange, files }: { exchange: ReturnType<typeof useMessages>; files: ReturnType<typeof useFiles> }) {
  const { model, label } = exchange
  useEffect(() => {
    void exchange.refreshFileStates()
    // 重入工作区只校正已加载文件，不重新加载历史或改变同步游标。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const composing = useRef(false)
  const picker = useRef<HTMLInputElement>(null)
  const [downloadNotice, setDownloadNotice] = useState('')
  const [copyNotice, setCopyNotice] = useState('')
  const list = useRef<HTMLDivElement>(null)
  const positioned = useRef(false)
  const following = useRef(true)
  const previousFirst = useRef<{ id: string; top: number } | null>(null)
  const [atBottom, setAtBottom] = useState(true)
  const [dragOver, setDragOver] = useState(false)

  function scrollToLatest() {
    const element = list.current
    if (element) element.scrollTop = element.scrollHeight
    following.current = true
    setAtBottom(true)
  }

  useLayoutEffect(() => {
    const element = list.current
    if (!element) return
    const previous = previousFirst.current
    const anchor = previous ? element.querySelector<HTMLElement>(`[data-message-id="${previous.id}"]`) : null
    // 旧页插入后按原首条的位置差补偿，不按总高度补偿，避免同时到达的新消息也把阅读位置推走。
    const prepended = previous && model.messages[0]?.id !== previous.id && anchor
    if (prepended) element.scrollTop += anchor.offsetTop - previous.top
    else if (model.syncCursor !== null && (!positioned.current || following.current)) scrollToLatest()
    if (model.syncCursor !== null) positioned.current = true
    const first = element.querySelector<HTMLElement>('[data-message-id]')
    previousFirst.current = first ? { id: first.dataset.messageId!, top: first.offsetTop } : null
  }, [model.messages, model.syncCursor])

  // 复制结果不包含正文；复制动作必须由用户触发，不能随消息读取自动改写剪贴板。
  async function copy(text: string) {
    setCopyNotice('')
    try { await navigator.clipboard.writeText(text); setCopyNotice('已复制完整正文') }
    catch { setCopyNotice('复制失败，请手动选择正文复制') }
  }

  async function download(fileId: string) {
    setDownloadNotice('')
    const notice = await files.download(fileId)
    if (notice) setDownloadNotice(notice)
  }

  return (
    <section className="stream chat-window-panel" aria-label="消息流">
      <div className="chat-window-header">
        <div className="chat-header-status-group">
          <div className="chat-status-indicator">
            <span className="chat-status-dot online" />
            <Text variant="heading" as="h2" DANGEROUS_className="chat-status-title">
              在线
            </Text>
          </div>
        </div>
        <div className="chat-header-actions stream-toolbar">
          <Button
            variant="ghost"
            size="sm"
            icon={<ArrowUpIcon />}
            style={{ visibility: model.hasOlder ? 'visible' : 'hidden' }}
            disabled={model.reading || !model.hasOlder}
            onClick={() => void exchange.read(true)}
          >
            加载更早消息
          </Button>
          <Button
            variant="ghost"
            size="sm"
            icon={<ArrowDownIcon />}
            style={{ visibility: atBottom ? 'hidden' : 'visible' }}
            onClick={scrollToLatest}
          >
            回到最新
          </Button>
          <Button
            variant="secondary"
            size="sm"
            icon={<ArrowClockwiseIcon />}
            disabled={model.reading}
            onClick={() => void exchange.refresh()}
          >
            读取最近消息
          </Button>
        </div>
      </div>

      {Boolean(model.historyNotice || model.notice || copyNotice || downloadNotice || exchange.fileStatusNotice) && (
        <div className="message-notice-group">
          {(model.historyNotice || model.notice) && (
            <div className="message-notice" aria-live="polite">
              <Text variant={(model.historyNotice || model.notice).includes('成功') ? 'success' : 'error'} size="sm">
                {model.historyNotice || model.notice}
              </Text>
            </div>
          )}
          {copyNotice && (
            <div className="message-notice" aria-live="polite">
              <Text variant={copyNotice.startsWith('复制失败') ? 'error' : 'success'} size="sm">
                {copyNotice}
              </Text>
            </div>
          )}
          {downloadNotice && <Text role="status" variant="error" size="sm">{downloadNotice}</Text>}
          {exchange.fileStatusNotice && <Text role="status" variant="error" size="sm">{exchange.fileStatusNotice}</Text>}
        </div>
      )}

      <div
        className="messages chat-messages-stream"
        ref={list}
        tabIndex={0}
        aria-label="消息历史"
        onScroll={() => {
          const element = list.current!
          following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 8
          setAtBottom(following.current)
        }}
      >
        {model.messages.length === 0 && (
          <div className="chat-empty-state">
            <Text variant="secondary">暂无消息。</Text>
          </div>
        )}

        {model.messages.length > 0 && (
          <div className="chat-date-pill-container">
            <span className="chat-date-pill">
              {formatMessageDate(model.messages[0].created_at)}
            </span>
          </div>
        )}

        {model.messages.map(message => {
          const isSelf = message.source_label === label
          const palette = isSelf ? null : getDevicePalette(message.source_label)

          return (
            <article
              key={message.id}
              data-message-id={message.id}
              className={`message chat-message-row ${isSelf ? 'chat-row-self' : 'chat-row-other'}`}
            >
              {!isSelf && (
                <div className="chat-message-avatar">
                  <UserAvatar label={message.source_label} size={36} />
                </div>
              )}

              <div className="chat-bubble-container">
                {!isSelf && (
                  <header className="chat-bubble-header">
                    <div
                      className="chat-device-tag"
                      style={palette ? { color: palette.text, borderColor: palette.border, backgroundColor: palette.badgeBg } : undefined}
                    >
                      <DesktopIcon size={12} className="chat-device-icon" />
                      <span className="message-source-label">{message.source_label}</span>
                    </div>
                  </header>
                )}

                <div
                  className={`chat-bubble-body ${isSelf ? 'bubble-self' : 'bubble-other'} ${message.kind === 'FILE' ? 'bubble-file-card' : ''}`}
                  style={!isSelf && palette && message.kind === 'TEXT' ? { backgroundColor: palette.bg, borderColor: palette.border } : undefined}
                >
                  {message.kind === 'TEXT' ? (
                    <div className="message-body text-message">
                      <pre className="message-text-content">{message.text}</pre>
                    </div>
                  ) : (
                    <div className="message-body file-message">
                      <div className="file-message-card">
                        <FileTypeBadge filename={message.file_name} size="md" />
                        <div className="file-message-details">
                          <Text DANGEROUS_className="file-message-meta">
                            {message.file_name}
                          </Text>
                          <Text variant="secondary" size="xs" DANGEROUS_className="file-message-size">
                            {formatBytes(message.file_size)}
                          </Text>
                          <div className="file-message-status-row">
                            <Badge variant={message.file_state === 'available' ? 'success' : message.file_state === 'deleted' ? 'secondary' : 'warning'}>
                              {fileStateLabels[message.file_state]}
                            </Badge>
                            {message.file_state === 'available' && (
                              <a
                                href={`/api/files/${encodeURIComponent(message.file_id)}`}
                                download
                                className="file-download-link"
                                onClick={event => { event.preventDefault(); void download(message.file_id) }}
                              >
                                <DownloadSimpleIcon size={14} />
                                <span>下载附件</span>
                              </a>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                <footer className="chat-bubble-footer">
                  <Text variant="secondary" size="xs" as="time" {...{ dateTime: message.created_at }}>
                    {formatMessageTime(message.created_at)}
                  </Text>
                  {message.kind === 'TEXT' && (
                    <div className="message-actions">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="btn-copy-bubble"
                        icon={<CopyIcon size={13} />}
                        onClick={() => void copy(message.text)}
                      >
                        复制正文
                      </Button>
                    </div>
                  )}
                </footer>
              </div>

              {isSelf && (
                <div className="chat-message-avatar">
                  <UserAvatar label={message.source_label} size={36} />
                </div>
              )}
            </article>
          )
        })}
      </div>

      {/* Dock Area: Upload Tasks, Warnings, and Send Recovery */}
      {(files.paused || files.tasks.length > 0 || model.attempt?.uncertain || files.limits === 'unavailable' || files.limits === 'loading') && (
        <div className="chat-dock-tray">
          {files.paused && (
            <div className="upload-paused-banner">
              <Text role="status" variant="secondary" size="sm">
                暂停新上传：网络不可用或仍有结果未确认。未确认项须手动查询或结束本轮，不会自动查询或重传。
              </Text>
            </div>
          )}

          {(files.limits === 'unavailable' || files.limits === 'loading') && (
            <div className="upload-tip-box">
              <Text variant="secondary" size="sm">
                {files.limits === 'loading' ? '正在读取服务器文件限制…' : '限制未知或离线，暂不可选择文件。'}
              </Text>
              {files.limits === 'unavailable' && (
                <Button variant="ghost" size="sm" onClick={() => void files.refresh()}>
                  重查文件限制
                </Button>
              )}
            </div>
          )}

          {files.tasks.length > 0 && (
            <div className="upload-tasks-section">
              <div className="upload-batch-toolbar">
                <span className="upload-queue-count">上传任务 ({files.tasks.length})</span>
                <Button variant="ghost" size="sm" onClick={files.endBatch}>
                  结束本轮
                </Button>
              </div>
              <div className="upload-tasks-list">
                {files.tasks.map(task => (
                  <div className="upload-task" key={task.sendId}>
                    <div className="upload-task-info">
                      <FileTypeBadge filename={task.name} size="sm" />
                      <Text DANGEROUS_className="upload-task-title">{task.name} · {formatBytes(task.size)}</Text>
                    </div>
                    <progress max={100} value={task.progress} aria-label={`${task.name} 上传进度`} />
                    <div className="upload-task-footer">
                      <Text role="status" variant={task.status === '上传成功' ? 'success' : task.pending ? 'secondary' : 'error'} size="sm">
                        {task.status}
                      </Text>
                      <div className="upload-task-actions">
                        {task.queued && <Button variant="ghost" size="sm" onClick={() => files.remove(task.sendId)}>移除等待项</Button>}
                        {task.pending && !task.unresolved && <Button variant="secondary" size="sm" onClick={() => files.interrupt(task.sendId)}>中断传输</Button>}
                        {task.unresolved && !task.pending && <Button variant="secondary" size="sm" onClick={() => void files.query(task.sendId)}>查询文件结果</Button>}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {model.attempt?.uncertain && (
            <div className="recovery chat-recovery-bar" aria-label="发送恢复">
              <Button variant="secondary" disabled={model.attempt.state !== 'unknown'} onClick={() => void exchange.query()}>
                查询发送结果
              </Button>
              <Button variant="secondary" disabled={model.attempt.state !== 'unknown'} onClick={() => void exchange.retry()}>
                同次重试
              </Button>
              <Button variant="ghost" onClick={exchange.abandon}>
                放弃确认
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Modern Grand Chat Composer Area */}
      <div
        className={`chat-composer-box ${dragOver ? 'drag-over' : ''}`}
        onDragOver={e => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={e => {
          e.preventDefault()
          setDragOver(false)
          const selected = Array.from(e.dataTransfer.files || [])
          if (selected.length && validLabel(label) && typeof files.limits === 'number') {
            void files.choose(selected, label)
          }
        }}
      >
        <input
          ref={picker}
          type="file"
          multiple
          aria-label="选择要上传的文件"
          className="file-picker"
          onChange={event => {
            const selected = Array.from(event.target.files || [])
            event.target.value = ''
            if (selected.length) void files.choose(selected, label)
          }}
        />

        <LayerCard className="composer-card-container">
          <div className="composer-main-input-area">
            <Textarea
              id="text-draft"
              aria-label="正文"
              value={model.draft}
              readOnly={Boolean(model.attempt)}
              placeholder="输入消息，Enter 换行，Ctrl + Enter 发送..."
              autoResize={true}
              minRows={2}
              maxRows={6}
              className="composer-textarea"
              onChange={e => exchange.draft(e.target.value)}
              onCompositionStart={() => { composing.current = true }}
              onCompositionEnd={() => { composing.current = false }}
              onKeyDown={e => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !composing.current && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                  e.preventDefault(); void exchange.send()
                }
              }}
            />
          </div>

          <div className="composer-bottom-toolbar">
            <div className="composer-toolbar-left">
              <Button
                variant="secondary"
                size="sm"
                shape="circle"
                aria-label="选择文件"
                title="选择文件"
                icon={<PaperclipIcon size={18} />}
                className="composer-attach-icon-btn"
                disabled={typeof files.limits !== 'number' || !validLabel(label)}
                onClick={() => picker.current?.click()}
              />
            </div>

            <div className="composer-toolbar-right">
              <span className="composer-shortcut-hint">
                <kbd>Ctrl</kbd> + <kbd>Enter</kbd> 发送
              </span>
              <Button
                variant="primary"
                size="sm"
                icon={<PaperPlaneTiltIcon size={15} weight="fill" />}
                className="composer-send-button"
                disabled={Boolean(model.attempt) || !validText(model.draft) || !validLabel(label)}
                onClick={() => void exchange.send()}
              >
                发送
              </Button>
            </div>
          </div>
        </LayerCard>
      </div>
    </section>
  )
}
