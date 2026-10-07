import { useEffect, useState } from 'react'
import { ArrowsClockwiseIcon, HardDrivesIcon, InfoIcon, PaperPlaneTiltIcon, WarningCircleIcon } from '@phosphor-icons/react'
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
  const [authenticated, setAuthenticated] = useState(false)
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

  const isWorkspace = state === 'initialized' && authenticated

  return (
    <main className={`app-shell ${isWorkspace ? 'workspace-mode' : 'auth-mode'}`}>
      {isWorkspace && (
        <header className="masthead">
          <div className="brand-lockup">
            <div className="brand-mark">
              <div className="brand-icon-mini">
                <PaperPlaneTiltIcon size={18} weight="fill" />
              </div>
              <Text variant="heading" as="h1">FileHop</Text>
            </div>
            <Badge variant="secondary">私人工作台</Badge>
          </div>
        </header>
      )}

      <div className={isWorkspace ? 'workspace-stage' : 'auth-container'}>
        {!isWorkspace && (
          <div className="auth-brand-header">
            <div className="brand-logo-emblem">
              <PaperPlaneTiltIcon size={28} weight="fill" />
            </div>
            <Text variant="heading" as="h1" size="lg" DANGEROUS_className="auth-brand-title">FileHop</Text>
            <Text variant="secondary" size="sm" DANGEROUS_className="auth-brand-subtitle">
              跨设备文本与文件交换 · 私人桌面工作台
            </Text>
          </div>
        )}

        {state === 'initialized' ? (
          <SessionPage onAuthenticatedChange={setAuthenticated} />
        ) : (
          <LayerCard className="auth-card status-card">
            <div className="auth-card-header">
              <div className="auth-card-title-row">
                {state === 'storage_error' ? (
                  <WarningCircleIcon size={24} weight="fill" className="text-danger" />
                ) : (
                  <HardDrivesIcon size={24} weight="duotone" className="text-brand" />
                )}
                <div>
                  <Text variant="heading" as="h2">服务状态</Text>
                  <Text variant="secondary" size="sm">
                    {state === 'uninitialized' ? '等待管理员在服务器端初始化' : state === 'storage_error' ? '检测到受管存储异常' : '连接服务器中'}
                  </Text>
                </div>
              </div>
              <div className={`auth-status-callout ${state === 'storage_error' || state === 'unavailable' ? 'error' : 'info'}`}>
                {state === 'storage_error' || state === 'unavailable' ? (
                  <WarningCircleIcon size={18} weight="fill" className="status-callout-icon" />
                ) : (
                  <InfoIcon size={18} weight="fill" className="status-callout-icon" />
                )}
                <Text role="status" variant={state === 'storage_error' || state === 'unavailable' ? 'error' : 'secondary'}>
                  {messages[state]}
                </Text>
              </div>
            </div>
            {state === 'uninitialized' && (
              <Text variant="secondary" size="sm" DANGEROUS_className="auth-guide-text">
                初始化只能由管理员在服务器上执行，不会因打开页面自动创建账户或数据库。
              </Text>
            )}
            <div className="action-row centered">
              <Button
                variant="primary"
                size="lg"
                icon={<ArrowsClockwiseIcon />}
                disabled={state === 'loading'}
                onClick={() => {
                  setState('loading')
                  setAttempt((value) => value + 1)
                }}
              >
                刷新状态
              </Button>
            </div>
          </LayerCard>
        )}

        {!isWorkspace && (
          <footer className="auth-footer">
            <Text variant="secondary" size="sm">
              账户由服务器管理员初始化 · 页面不提供公开注册
            </Text>
          </footer>
        )}
      </div>
    </main>
  )
}
