import { defineConfig, devices } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const PORT = 5174
const BASE_URL = `http://localhost:${PORT}`

// Chinese-style local timestamp: 5月27日_14时30分
function makeRunStamp() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}月${d.getDate()}日_${pad(d.getHours())}时${pad(d.getMinutes())}分`
}

// Reuse the same stamp across workers / specs by passing it through env.
// If a parent shell already set RUN_STAMP, honor it (useful for orchestrated runs).
if (!process.env.RUN_STAMP) {
  process.env.RUN_STAMP = makeRunStamp()
}
const RUN_STAMP = process.env.RUN_STAMP

const RUN_DIR = path.join(__dirname, 'results', RUN_STAMP)

// Surface the run directory to specs.
process.env.RUN_DIR = RUN_DIR

export default defineConfig({
  testDir: path.join(__dirname, 'tests'),
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  outputDir: path.join(RUN_DIR, 'test-output'),
  reporter: [
    ['list'],
    ['html', { outputFolder: path.join(RUN_DIR, 'playwright-report'), open: 'never' }],
  ],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm run dev',
    cwd: path.resolve(__dirname, '..', '..'),
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 120_000,
  },
  projects: [
    { name: 'iphone-se',        use: { ...devices['iPhone SE'] } },
    { name: 'iphone-12',        use: { ...devices['iPhone 12'] } },
    { name: 'iphone-14-promax', use: { ...devices['iPhone 14 Pro Max'] } },
    { name: 'pixel-5',          use: { ...devices['Pixel 5'] } },
    { name: 'pixel-7',          use: { ...devices['Pixel 7'] } },
    { name: 'galaxy-s9plus',    use: { ...devices['Galaxy S9+'] } },
    { name: 'galaxy-tab-s4',    use: { ...devices['Galaxy Tab S4'] } },
    { name: 'ipad-mini',        use: { ...devices['iPad Mini'] } },
    { name: 'ipad-pro-11',      use: { ...devices['iPad Pro 11'] } },
    { name: 'desktop-chrome',   use: { ...devices['Desktop Chrome'] } },
    { name: 'desktop-safari',   use: { ...devices['Desktop Safari'] } },
  ],
})
