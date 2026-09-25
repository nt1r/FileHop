import { useLayoutEffect, useRef, useState } from 'react'
import { ArrowClockwiseIcon, ArrowDownIcon, ArrowUpIcon, CopyIcon, PaperPlaneTiltIcon } from '@phosphor-icons/react'
import { Button } from '@cloudflare/kumo/components/button'
import { Input, Textarea } from '@cloudflare/kumo/components/input'
import { LayerCard } from '@cloudflare/kumo/components/layer-card'
import { Text } from '@cloudflare/kumo/components/text'
import { type useMessages, validLabel, validText } from './messages'
import { type useFiles } from './files'

export default function Messages({ exchange, files }: { exchange: ReturnType<typeof useMessages>; files: ReturnType<typeof useFiles> }) {
  const { model, label } = exchange
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
    <LayerCard className="panel">
      <div className="panel-heading">
        <div>
          <Text variant="heading3" as="h2">消息流</Text>
          <Text variant="secondary" size="sm">最近消息在下方，历史向上延伸。</Text>
        </div>
        <div className="stream-toolbar">
          <Button variant="secondary" icon={<ArrowClockwiseIcon />} disabled={model.reading} onClick={() => void exchange.read()}>读取最近消息</Button>
          <Button variant="ghost" icon={<ArrowUpIcon />} style={{ visibility: model.hasOlder ? 'visible' : 'hidden' }} disabled={model.reading || !model.hasOlder} onClick={() => void exchange.read(true)}>加载更早消息</Button>
          <Button variant="ghost" icon={<ArrowDownIcon />} style={{ visibility: atBottom ? 'hidden' : 'visible' }} onClick={scrollToLatest}>回到最新</Button>
        </div>
      </div>
      <div className="message-notice" aria-live="polite"><Text variant={(model.historyNotice || model.notice).includes('成功') ? 'success' : model.historyNotice || model.notice ? 'error' : 'secondary'} size="sm">{model.historyNotice || model.notice || ' '}</Text></div>
      <div className="message-notice" aria-live="polite"><Text variant={copyNotice.startsWith('复制失败') ? 'error' : copyNotice ? 'success' : 'secondary'} size="sm">{copyNotice || ' '}</Text></div>
      {downloadNotice && <Text role="status" variant="error" size="sm">{downloadNotice}</Text>}
      <div className="messages" ref={list} tabIndex={0} aria-label="消息历史" onScroll={() => {
        const element = list.current!
        following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 8
        setAtBottom(following.current)
      }}>
        {model.messages.length === 0 && <Text variant="secondary">暂无消息。</Text>}
        {model.messages.map(message => <LayerCard key={message.id} className="message" render={<article data-message-id={message.id} />}>
          <header>
            <Text variant="heading" as="span">{message.source_label}</Text>
            <Text variant="secondary" size="xs" as="time" {...{ dateTime: message.created_at }}>{message.created_at}</Text>
          </header>
          {message.kind === 'TEXT' ? <>
            <Text as="pre">{message.text}</Text>
            <div><Button variant="ghost" size="sm" icon={<CopyIcon />} onClick={() => void copy(message.text)}>复制正文</Button></div>
          </> : <div>
            {/* 文件消息不是空文本；只展示元数据，下载交给浏览器处理，不把不可信内容内联渲染。 */}
            <Text>{message.file_name} · {message.file_size.toLocaleString('zh-CN')} 字节 · {message.file_mime || '未知类型'}</Text>
            <a href={`/api/files/${encodeURIComponent(message.file_id)}`} download onClick={event => { event.preventDefault(); void download(message.file_id) }}>下载附件</a>
          </div>}
        </LayerCard>)}
      </div>
    </LayerCard>

    <LayerCard className="panel upload-panel">
      <div className="panel-heading"><Text variant="heading3" as="h2">文件交换</Text>
        <Button variant="secondary" disabled={typeof files.limits !== 'number' || !validLabel(label) || files.busy} onClick={() => picker.current?.click()}>选择文件</Button></div>
      <input ref={picker} type="file" aria-label="选择要上传的文件" className="file-picker" onChange={event => {
        const file = event.target.files?.[0]
        event.target.value = ''
        if (file) void files.choose(file, label)
      }} />
      <Text variant="secondary" size="sm">{typeof files.limits === 'number' ? `单文件上限 ${files.limits.toLocaleString('zh-CN')} 字节；服务器最终确认准入。` :
        files.limits === 'loading' ? '正在读取服务器文件限制…' : '限制未知或离线，暂不可选择文件。'} 刷新后不会恢复上传；重新选择前请先检查消息历史。</Text>
      {files.limits === 'unavailable' && <Button variant="ghost" onClick={() => void files.refresh()}>重查文件限制</Button>}
      {files.tasks.map(task => <div className="upload-task" key={task.sendId}>
        <Text>{task.name} · {task.size.toLocaleString('zh-CN')} 字节</Text>
        <progress max={100} value={task.progress} aria-label={`${task.name} 上传进度`} />
        <Text role="status" variant={task.status === '上传成功' ? 'success' : task.pending ? 'secondary' : 'error'} size="sm">{task.status}</Text>
      </div>)}
    </LayerCard>

    <LayerCard className="panel composer">
      <div className="composer-heading">
        <Text variant="heading3" as="h2">发送</Text>
        <Text variant="mono">{bytes.toLocaleString('zh-CN')} / 65,536 字节</Text>
      </div>
      <Input label="来源标签" value={label} error={validLabel(label) ? undefined : '来源标签去除首尾空白后须为 1–64 个字符。'} onChange={e => exchange.setLabel(e.target.value)} onBlur={() => exchange.saveLabel(label)} />
      <Textarea id="text-draft" label="正文" value={model.draft} readOnly={Boolean(model.attempt)} description={`${bytes} / 65,536 UTF-8 字节 · Enter 换行，Ctrl/Cmd+Enter 发送。草稿仅保存在当前页面。`} onChange={e => exchange.draft(e.target.value)}
        onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
        onKeyDown={e => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !composing.current && !e.nativeEvent.isComposing && e.keyCode !== 229) {
            e.preventDefault(); void exchange.send()
          }
        }} />
      {model.attempt?.uncertain && <div className="recovery" aria-label="发送恢复">
        <Button variant="secondary" disabled={model.attempt.state !== 'unknown'} onClick={() => void exchange.query()}>查询发送结果</Button>
        <Button variant="secondary" disabled={model.attempt.state !== 'unknown'} onClick={() => void exchange.retry()}>同次重试</Button>
        <Button variant="ghost" onClick={exchange.abandon}>放弃确认</Button>
      </div>}
      <div className="action-row">
        <Button variant="primary" icon={<PaperPlaneTiltIcon />} disabled={Boolean(model.attempt) || !validText(model.draft) || !validLabel(label)} onClick={() => void exchange.send()}>发送</Button>
      </div>
    </LayerCard>
  </section>
}
