import { test } from '@playwright/test'
import path from 'node:path'

const RUN_DIR = process.env.RUN_DIR
if (!RUN_DIR) {
  throw new Error('RUN_DIR env var not set — run via playwright config in data-prep/monkey-test/')
}

const ROUTES = [
  { name: 'entry',    path: '/' },
  { name: 'learning', path: '/?page=learn' },
  { name: 'wordlist', path: '/?page=words' },
  { name: 'settings', path: '/?page=settings' },
]

test.describe('cross-device screenshots', () => {
  for (const route of ROUTES) {
    test(`screenshot - ${route.name}`, async ({ page }, testInfo) => {
      await page.goto(route.path, { waitUntil: 'networkidle' })
      await page.waitForTimeout(800)
      const file = path.join(
        RUN_DIR,
        'screenshots',
        `${testInfo.project.name}__${route.name}.png`,
      )
      await page.screenshot({ path: file, fullPage: true })
    })
  }
})
