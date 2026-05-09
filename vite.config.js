import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
  optimizeDeps: {
    include: ['react', 'react-dom', 'posthog-js', '@posthog/react'],
  },
  build: {
    sourcemap: false,
  },
  server: {
    port: parseInt(process.env.PORT) || 5174,
    open: false,
    host: true
  }
})
