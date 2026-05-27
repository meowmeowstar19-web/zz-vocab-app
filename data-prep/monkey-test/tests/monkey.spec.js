import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..')

const RUN_DIR = process.env.RUN_DIR
if (!RUN_DIR) {
  throw new Error('RUN_DIR env var not set — run via playwright config in data-prep/monkey-test/')
}

const ATTACK_COUNT = Number(process.env.MONKEY_ATTACKS || 500)
const GREMLINS_PATH = path.join(PROJECT_ROOT, 'node_modules', 'gremlins.js', 'dist', 'gremlins.min.js')

test.describe('monkey test', () => {
  test('random interactions', async ({ page }, testInfo) => {
    const consoleErrors = []
    const pageErrors = []

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push({ text: msg.text(), location: msg.location() })
      }
    })
    page.on('pageerror', (err) => {
      pageErrors.push({ message: err.message, stack: err.stack })
    })

    await page.goto('/', { waitUntil: 'networkidle' })
    await page.waitForTimeout(1000)

    const gremlinsSrc = fs.readFileSync(GREMLINS_PATH, 'utf8')
    await page.addScriptTag({ content: gremlinsSrc })

    await page
      .evaluate(async (nb) => {
        const g = window.gremlins
        const horde = g.createHorde({
          species: [
            g.species.clicker(),
            g.species.toucher(),
            g.species.formFiller(),
            g.species.scroller(),
            g.species.typer(),
          ],
          mogwais: [g.mogwais.alert(), g.mogwais.fps(), g.mogwais.gizmo()],
          strategies: [g.strategies.distribution({ nb })],
        })
        await horde.unleash()
      }, ATTACK_COUNT)
      .catch((e) => {
        pageErrors.push({ message: `gremlins eval error: ${e.message}`, stack: e.stack })
      })

    const outDir = path.join(RUN_DIR, 'monkey')
    fs.mkdirSync(outDir, { recursive: true })
    const stem = testInfo.project.name
    fs.writeFileSync(
      path.join(outDir, `${stem}.json`),
      JSON.stringify({ consoleErrors, pageErrors, attacks: ATTACK_COUNT }, null, 2),
    )
    await page.screenshot({ path: path.join(outDir, `${stem}.png`), fullPage: true })

    expect(
      pageErrors,
      `Page errors during monkey run:\n${JSON.stringify(pageErrors, null, 2)}`,
    ).toEqual([])
  })
})
