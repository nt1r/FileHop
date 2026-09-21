import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Docker passes this explicitly; do not load secrets into the client bundle.
const devHost = process.env.FILEHOP_DEV_HOST
if (devHost && !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(devHost)) {
  throw new Error('FILEHOP_DEV_HOST must be a hostname, not a URL')
}

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    allowedHosts: devHost ? [devHost] : [],
    ...(devHost ? { hmr: { protocol: 'wss', host: devHost, clientPort: 443 } } : {}),
  },
})
