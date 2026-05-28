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
    rollupOptions: {
      output: {
        // Split the rarely-changing third-party libs into their own chunk so
        // day-to-day deploys (which only touch app code) re-hash just the
        // index chunk — the bigger vendor chunk stays byte-identical and keeps
        // hitting the SW's permanent build-assets cache. NOTE: keep sw.js
        // isBuildAsset() matching the `vendor-` prefix in sync with this.
        manualChunks: {
          vendor: ['react', 'react-dom', '@supabase/supabase-js', 'posthog-js', '@posthog/react'],
        },
      },
    },
  },
  server: {
    port: parseInt(process.env.PORT) || 5174,
    open: false,
    host: true
  }
})
