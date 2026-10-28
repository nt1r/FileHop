import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { BrowserRouter } from 'react-router-dom'
import { Toast } from '@cloudflare/kumo/components/toast'
import Notifications from './Notifications'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Toast.Provider>
        <App />
        <Notifications />
      </Toast.Provider>
    </BrowserRouter>
  </StrictMode>,
)
