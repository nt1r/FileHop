import { useEffect, useState } from 'react'
import { ArrowsClockwiseIcon, DesktopIcon, DeviceMobileIcon, ShieldCheckIcon } from '@phosphor-icons/react'
import { Badge } from '@cloudflare/kumo/components/badge'
import { Button } from '@cloudflare/kumo/components/button'
import { LayerCard } from '@cloudflare/kumo/components/layer-card'
import { Text } from '@cloudflare/kumo/components/text'
import SessionPage from './Session'

type State = 'loading' | 'uninitialized' | 'initialized' | 'storage_error' | 'unavailable'
const messages: Record<State, string> = {
  loading: '正在检查初始化状态…',
  uninitialized: '请管理员先初始化：在服务器上运行显式初始化命令。此页面不提供注册。',
  initialized: '已初始化。',
  storage_error: '存储异常。请管理员检查挂载、存储标识及初始化状态；不要删除数据或重新初始化。',
  unavailable: '无法获取应用状态。请检查网络或开发访问层，然后重试。',
}

export default function App() {
  const [state, setState] = useState<State>('loading')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    let active = true
    const timer = window.setTimeout(() => controller.abort(), 15_000)
    async function load() {
      try {
        const response = await fetch('/api/status', { signal: controller.signal, cache: 'no-store' })
        if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
          throw new Error('Invalid application response')
        }
        const value: unknown = await response.json()
        if (typeof value !== 'object' || value === null || !('state' in value) ||
          (value.state !== 'uninitialized' && value.state !== 'initialized' && value.state !== 'storage_error')) {
          throw new Error('Invalid application state')
        }
        if (active) setState(value.state)
      } catch {
        if (active) setState('unavailable')
      } finally {
        window.clearTimeout(timer)
      }
    }
    void load()
    return () => { active = false; window.clearTimeout(timer); controller.abort() }
  }, [attempt])

  return (
    <main className="app-shell">
      <header className="masthead">
        <div className="brand-lockup">
          <div className="brand-mark">
            <Badge variant="primary">FileHop</Badge>
            <Text variant="secondary" size="sm">私人桌面工作台</Text>
          </div>
          <Text variant="heading" as="p" size="lg">一台服务器，连接你的桌面。</Text>
        </div>
        <Badge variant={state === 'storage_error' || state === 'unavailable' ? 'outline' : 'secondary'}>
          {state === 'initialized' ? '服务已初始化' : state === 'loading' ? '正在连接' : '等待管理员'}
        </Badge>
      </header>

      <div className="stage">
        <section className="intro">
          <Text variant="secondary" size="sm" bold>DESKTOP WEB</Text>
          <Text variant="heading" as="h1" DANGEROUS_className="intro-title">跨设备文本与文件交换</Text>
          <Text variant="secondary" size="lg">在自己的服务器上传递文字、链接、命令片段和文件。所有设备共享同一条私人消息流。</Text>
          <ul className="capability-list">
            <li><DesktopIcon size={22} /><Text>桌面浏览器直接登录、阅读和发送。</Text></li>
            <li><DeviceMobileIcon size={22} /><Text>Android 使用同一条历史，无需选择接收设备。</Text></li>
            <li><ShieldCheckIcon size={22} /><Text>账户只由服务器管理员初始化，页面不提供注册。</Text></li>
          </ul>
        </section>

        <div className="workspace">
          {state === 'initialized' ? <SessionPage /> : <LayerCard className="panel status-panel">
            <div>
              <Text variant="heading3" as="h2">服务状态</Text>
              <Text role="status" variant={state === 'storage_error' || state === 'unavailable' ? 'error' : 'secondary'}>{messages[state]}</Text>
            </div>
            {/* 已初始化后由会话页处理重试，不能用诊断刷新重新挂载会话页，绕过内存中的退出待确认状态。 */}
            <div className="action-row">
              <Button variant="primary" icon={<ArrowsClockwiseIcon />} disabled={state === 'loading'} onClick={() => {
                setState('loading')
                setAttempt((value) => value + 1)
              }}>刷新状态</Button>
            </div>
          </LayerCard>}
          <Text variant="secondary" size="sm">初始化只能由管理员在服务器上执行，不会因打开页面自动创建账户或数据库。</Text>
        </div>
      </div>
    </main>
  )
}
