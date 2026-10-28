import { CheckCircleIcon, WarningCircleIcon, XIcon } from '@phosphor-icons/react'
import { Button } from '@cloudflare/kumo/components/button'
import { Toast, useKumoToastManager } from '@cloudflare/kumo/components/toast'

// Kumo Toasty 固定在右下角，会遮住发送按钮；这里只定制展示位置，计时和无障碍仍交给 Toast。
export default function Notifications() {
  const { toasts } = useKumoToastManager()
  return (
    <Toast.Portal>
      <Toast.Viewport className="notification-viewport" aria-label="操作提示">
        {toasts.map(toast => (
          <Toast.Root key={toast.id} toast={toast} className="notification" data-variant={toast.variant}>
            <Toast.Content className="notification-content">
              {toast.variant === 'error' ? <WarningCircleIcon size={20} weight="fill" /> : <CheckCircleIcon size={20} weight="fill" />}
              <Toast.Title className="notification-title" />
              <Toast.Close aria-label="关闭提示" render={<Button variant="ghost" size="sm" shape="square" aria-label="关闭提示" icon={<XIcon />} />} />
            </Toast.Content>
          </Toast.Root>
        ))}
      </Toast.Viewport>
    </Toast.Portal>
  )
}
