import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: {
      // Use the slim entry everywhere: the default '@posthog/react' entry
      // statically imports ALL of posthog-js (for its apiKey-init mode we
      // don't use), which would drag ~190KB min back onto the startup path.
      // posthog-js itself is dynamic-imported after `load` — see
      // src/utils/lazyPosthog.js. The slim entry exports the same
      // PostHogProvider/usePostHog on the same context.
      '@posthog/react': '@posthog/react/dist/esm/slim/index.js',
    },
  },
  optimizeDeps: {
    include: ['react', 'react-dom', 'posthog-js'],
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
        // posthog-js is intentionally NOT listed: it's only reachable via the
        // dynamic import in src/utils/lazyPosthog.js, so Rollup emits it as
        // its own lazy chunk that downloads after `load`. Listing it here
        // would force it back into the startup-critical vendor chunk. Same
        // for '@posthog/react': listing it resolves the package's DEFAULT
        // entry (which statically imports all of posthog-js), bypassing the
        // slim alias above — the aliased slim module (~8KB) just rides in the
        // index chunk instead.
        manualChunks: {
          vendor: ['react', 'react-dom', '@supabase/supabase-js'],
          // Its own chunk purely for a readable filename (posthog-<hash>.js
          // instead of module-<hash>.js). Only dynamically imported, so the
          // chunk stays lazy — grouping here does not put it back on the
          // startup path (unlike listing it inside `vendor`, which loads at
          // startup because react lives there).
          posthog: ['posthog-js'],
        },
      },
    },
  },
  server: {
    port: parseInt(process.env.PORT) || 5174,
    open: false,
    host: true,
    allowedHosts: ['dev.plushieword.com']
  }
})
