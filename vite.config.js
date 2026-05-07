import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    sourcemap: false,
  },
  server: {
    port: parseInt(process.env.PORT) || 5174,
    open: false,
    host: true
  }
})
