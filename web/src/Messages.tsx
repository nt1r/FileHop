import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowClockwiseIcon, ArrowDownIcon, ArrowUpIcon, CopyIcon, DesktopIcon, DownloadSimpleIcon, FileTextIcon, PaperPlaneTiltIcon, UploadSimpleIcon } from '@phosphor-icons/react'
import { Badge } from '@cloudflare/kumo/components/badge'
import { Button } from '@cloudflare/kumo/components/button'
import { Input, Textarea } from '@cloudflare/kumo/components/input'
import { LayerCard } from '@cloudflare/kumo/components/layer-card'
import { Text } from '@cloudflare/kumo/components/text'
import { fileStateLabels, type useMessages, validLabel, validText } from './messages'
import { type useFiles } from './files'

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
  const bytes = new TextEncoder().encode(model.draft).length
  return <section className="stream" aria-label="消息流">
    <LayerCard className="panel message-stream-panel">
      <div className="panel-heading">
        <div>
          <Text variant="heading3" as="h2">消息流</Text>
          <Text variant="secondary" size="sm">最近消息在下方，历史向上延伸 · 多端共享</Text>
        </div>
        <div className="stream-toolbar">
          <Button variant="secondary" size="sm" icon={<ArrowClockwiseIcon />} disabled={model.reading} onClick={() => void exchange.refresh()}>读取最近消息</Button>
          <Button variant="ghost" size="sm" icon={<ArrowUpIcon />} style={{ visibility: model.hasOlder ? 'visible' : 'hidden' }} disabled={model.reading || !model.hasOlder} onClick={() => void exchange.read(true)}>加载更早消息</Button>
          <Button variant="ghost" size="sm" icon={<ArrowDownIcon />} style={{ visibility: atBottom ? 'hidden' : 'visible' }} onClick={scrollToLatest}>回到最新</Button>
        </div>
      </div>
      <div className="message-notice" aria-live="polite"><Text variant={(model.historyNotice || model.notice).includes('成功') ? 'success' : model.historyNotice || model.notice ? 'error' : 'secondary'} size="sm">{model.historyNotice || model.notice || ' '}</Text></div>
      <div className="message-notice" aria-live="polite"><Text variant={copyNotice.startsWith('复制失败') ? 'error' : copyNotice ? 'success' : 'secondary'} size="sm">{copyNotice || ' '}</Text></div>
      {downloadNotice && <Text role="status" variant="error" size="sm">{downloadNotice}</Text>}
      {exchange.fileStatusNotice && <Text role="status" variant="error" size="sm">{exchange.fileStatusNotice}</Text>}
      <div className="messages" ref={list} tabIndex={0} aria-label="消息历史" onScroll={() => {
        const element = list.current!
        following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 8
        setAtBottom(following.current)
      }}>
        {model.messages.length === 0 && <Text variant="secondary">暂无消息。</Text>}
        {model.messages.map(message => <LayerCard key={message.id} className="message message-item-card" render={<article data-message-id={message.id} />}>
          <header className="message-header">
            <div className="message-source-chip">
              <DesktopIcon size={14} className="message-source-icon" />
              <Text variant="heading" as="span" DANGEROUS_className="message-source-label">{message.source_label}</Text>
            </div>
            <Text variant="secondary" size="xs" as="time" {...{ dateTime: message.created_at }}>{message.created_at}</Text>
          </header>
          {message.kind === 'TEXT' ? <div className="message-body text-message">
            <Text as="pre">{message.text}</Text>
            <div className="message-actions">
              <Button variant="ghost" size="sm" icon={<CopyIcon size={14} />} onClick={() => void copy(message.text)}>复制正文</Button>
            </div>
          </div> : <div className="message-body file-message">
            <div className="file-message-card">
              <div className="file-message-icon-box">
                <FileTextIcon size={24} weight="duotone" className="text-brand" />
              </div>
              <div className="file-message-details">
                <Text DANGEROUS_className="file-message-meta">{message.file_name} · {message.file_size.toLocaleString('zh-CN')} 字节 · {message.file_mime || '未知类型'}</Text>
                <div className="file-message-status-row">
                  <Badge variant={message.file_state === 'available' ? 'success' : message.file_state === 'deleted' ? 'secondary' : 'warning'}>
                    {fileStateLabels[message.file_state]}
                  </Badge>
                  {message.file_state === 'available' && <a href={`/api/files/${encodeURIComponent(message.file_id)}`} download className="file-download-link" onClick={event => { event.preventDefault(); void download(message.file_id) }}><DownloadSimpleIcon size={14} /><span>下载附件</span></a>}
                </div>
              </div>
            </div>
          </div>}
        </LayerCard>)}
      </div>
    </LayerCard>

    <LayerCard className="panel upload-panel">
      <div className="panel-heading">
        <div>
          <Text variant="heading3" as="h2">文件交换</Text>
          <Text variant="secondary" size="sm">跨设备流式传输 · 单页面串行上传并自动接续</Text>
        </div>
        <Button variant="secondary" icon={<UploadSimpleIcon size={16} />} disabled={typeof files.limits !== 'number' || !validLabel(label)} onClick={() => picker.current?.click()}>选择文件</Button>
      </div>
      <input ref={picker} type="file" multiple aria-label="选择要上传的文件" className="file-picker" onChange={event => {
        const selected = Array.from(event.target.files || [])
        event.target.value = ''
        if (selected.length) void files.choose(selected, label)
      }} />
      <div className="upload-tip-box">
        <Text variant="secondary" size="sm">{typeof files.limits === 'number' ? `单文件上限 ${files.limits.toLocaleString('zh-CN')} 字节；服务器最终确认准入。` :
          files.limits === 'loading' ? '正在读取服务器文件限制…' : '限制未知或离线，暂不可选择文件。'} 刷新后不会恢复上传；重新选择前请先检查消息历史。</Text>
        {files.limits === 'unavailable' && <Button variant="ghost" size="sm" onClick={() => void files.refresh()}>重查文件限制</Button>}
      </div>
      {files.paused && <div className="upload-paused-banner"><Text role="status" variant="secondary" size="sm">暂停新上传：网络不可用或仍有结果未确认。未确认项须手动查询或结束本轮，不会自动查询或重传。</Text></div>}
      {files.tasks.length > 0 && <div className="upload-batch-toolbar"><Button variant="ghost" size="sm" onClick={files.endBatch}>结束本轮</Button></div>}
      {files.tasks.map(task => <div className="upload-task" key={task.sendId}>
        <div className="upload-task-info">
          <FileTextIcon size={20} className="text-brand" />
          <Text DANGEROUS_className="upload-task-title">{task.name} · {task.size.toLocaleString('zh-CN')} 字节</Text>
        </div>
        <progress max={100} value={task.progress} aria-label={`${task.name} 上传进度`} />
        <div className="upload-task-footer">
          <Text role="status" variant={task.status === '上传成功' ? 'success' : task.pending ? 'secondary' : 'error'} size="sm">{task.status}</Text>
          <div className="upload-task-actions">
            {task.queued && <Button variant="ghost" size="sm" onClick={() => files.remove(task.sendId)}>移除等待项</Button>}
            {task.pending && !task.unresolved && <Button variant="secondary" size="sm" onClick={() => files.interrupt(task.sendId)}>中断传输</Button>}
            {task.unresolved && !task.pending && <Button variant="secondary" size="sm" onClick={() => void files.query(task.sendId)}>查询文件结果</Button>}
          </div>
        </div>
      </div>)}
    </LayerCard>

    <LayerCard className="panel composer">
      <div className="composer-heading">
        <div>
          <Text variant="heading3" as="h2">发送文本</Text>
          <Text variant="secondary" size="sm">所有已登录设备同步共享同一条私人消息流</Text>
        </div>
        <div className="composer-byte-meter">
          <Text variant="mono">{bytes.toLocaleString('zh-CN')} / 65,536 字节</Text>
        </div>
      </div>
      <div className="composer-input-row">
        <Input
          label="来源标签"
          value={label}
          placeholder="例如 桌面 Chrome"
          error={validLabel(label) ? undefined : '来源标签去除首尾空白后须为 1–64 个字符。'}
          onChange={e => exchange.setLabel(e.target.value)}
          onBlur={() => exchange.saveLabel(label)}
        />
      </div>
      <Textarea
        id="text-draft"
        label="正文"
        value={model.draft}
        readOnly={Boolean(model.attempt)}
        placeholder="输入要跨设备传递的文字、链接、代码片段或命令……"
        description={`${bytes} / 65,536 UTF-8 字节 · Enter 换行，Ctrl/Cmd+Enter 发送。草稿仅保存在当前页面。`}
        onChange={e => exchange.draft(e.target.value)}
        onCompositionStart={() => { composing.current = true }}
        onCompositionEnd={() => { composing.current = false }}
        onKeyDown={e => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !composing.current && !e.nativeEvent.isComposing && e.keyCode !== 229) {
            e.preventDefault(); void exchange.send()
          }
        }}
      />
      {model.attempt?.uncertain && <div className="recovery" aria-label="发送恢复">
        <Button variant="secondary" disabled={model.attempt.state !== 'unknown'} onClick={() => void exchange.query()}>查询发送结果</Button>
        <Button variant="secondary" disabled={model.attempt.state !== 'unknown'} onClick={() => void exchange.retry()}>同次重试</Button>
        <Button variant="ghost" onClick={exchange.abandon}>放弃确认</Button>
      </div>}
      <div className="action-row composer-footer-actions">
        <Text variant="secondary" size="xs" DANGEROUS_className="composer-key-tip">快捷键：Ctrl / ⌘ + Enter 发送</Text>
        <Button variant="primary" icon={<PaperPlaneTiltIcon size={16} weight="bold" />} disabled={Boolean(model.attempt) || !validText(model.draft) || !validLabel(label)} onClick={() => void exchange.send()}>发送</Button>
      </div>
    </LayerCard>
  </section>
}
