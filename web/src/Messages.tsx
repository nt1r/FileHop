import { useLayoutEffect, useRef, useState } from 'react'
import { Button } from '@cloudflare/kumo/components/button'
import { type useMessages, validLabel, validText } from './messages'

export default function Messages({ exchange }: { exchange: ReturnType<typeof useMessages> }) {
  const { model, label } = exchange
  const composing = useRef(false)
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
  return <section aria-label="消息流">
    <h2>消息流</h2>
    <Button disabled={model.reading} onClick={() => void exchange.read()}>读取最近消息</Button>
    <Button style={{ visibility: model.hasOlder ? 'visible' : 'hidden' }} disabled={model.reading || !model.hasOlder} onClick={() => void exchange.read(true)}>加载更早消息</Button>
    <Button style={{ visibility: atBottom ? 'hidden' : 'visible' }} onClick={scrollToLatest}>回到最新</Button>
    <p className="message-notice" aria-live="polite">{model.historyNotice || model.notice}</p>
    <p className="message-notice" aria-live="polite">{copyNotice}</p>
    <div className="messages" ref={list} tabIndex={0} aria-label="消息历史" onScroll={() => {
      const element = list.current!
      following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 8
      setAtBottom(following.current)
    }}>
      {model.messages.length === 0 && <p>暂无消息。</p>}
      {model.messages.map(message => <article key={message.id} data-message-id={message.id}>
        <p className="message-meta">{message.source_label} · <time dateTime={message.created_at}>{message.created_at}</time></p>
        <pre>{message.text}</pre>
        <Button onClick={() => void copy(message.text)}>复制正文</Button>
      </article>)}
    </div>
    <label>来源标签<input value={label} onChange={e => exchange.setLabel(e.target.value)} onBlur={() => exchange.saveLabel(label)} /></label>
    {!validLabel(label) && <p>来源标签去除首尾空白后须为 1–64 个字符。</p>}
    <label htmlFor="text-draft">正文</label><textarea id="text-draft" value={model.draft} readOnly={Boolean(model.attempt)} onChange={e => exchange.draft(e.target.value)}
      onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
      onKeyDown={e => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !composing.current && !e.nativeEvent.isComposing && e.keyCode !== 229) {
          e.preventDefault(); void exchange.send()
        }
      }} />
    <p className="notice">{new TextEncoder().encode(model.draft).length} / 65,536 UTF-8 字节 · Enter 换行，Ctrl/Cmd+Enter 发送。草稿仅保存在当前页面。</p>
    {model.attempt?.uncertain && <div aria-label="发送恢复">
      <Button disabled={model.attempt.state !== 'unknown'} onClick={() => void exchange.query()}>查询发送结果</Button>
      <Button disabled={model.attempt.state !== 'unknown'} onClick={() => void exchange.retry()}>同次重试</Button>
      <Button onClick={exchange.abandon}>放弃确认</Button>
    </div>}
    <Button variant="primary" disabled={Boolean(model.attempt) || !validText(model.draft) || !validLabel(label)} onClick={() => void exchange.send()}>发送</Button>
  </section>
}
