import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { BrowserRouter } from 'react-router-dom'
import { Toasty } from '@cloudflare/kumo/components/toast'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Toasty>
        <App />
      </Toasty>
    </BrowserRouter>
  </StrictMode>,
)
