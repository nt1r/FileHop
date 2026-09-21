import { useEffect, useState } from 'react'
import { Button } from '@cloudflare/kumo/components/button'

type State = 'loading' | 'uninitialized' | 'initialized' | 'storage_error' | 'unavailable'
const messages: Record<State, string> = {
  loading: '正在检查初始化状态…',
  uninitialized: '请管理员先初始化：在服务器上运行显式初始化命令。此页面不提供注册。',
  initialized: '已初始化。账户与受管存储已就绪；登录功能将在后续任务实现。',
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
    <main className="welcome">
      <p className="eyebrow">FileHop</p>
      <h1>跨设备文本与文件交换</h1>
      <p role="status">{messages[state]}</p>
      <Button variant="primary" disabled={state === 'loading'} onClick={() => {
        setState('loading')
        setAttempt((value) => value + 1)
      }}>刷新状态</Button>
      <p className="notice">初始化只能由管理员在服务器上执行，不会因打开页面自动创建账户或数据库。</p>
    </main>
  )
}
