import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium, defineConfig } from '@playwright/test'

function resolveBrowserLaunchConfig(): {
  executablePath?: string
  channel?: string
} {
  try {
    const defaultPath = chromium.executablePath()
    if (defaultPath && fs.existsSync(defaultPath)) {
      return { executablePath: defaultPath }
    }
  } catch {
    // Fall through to secondary candidates
  }

  const localPlaywrightChrome =
    'C:\\Users\\carlos\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe'
  if (fs.existsSync(localPlaywrightChrome)) {
    return { executablePath: localPlaywrightChrome }
  }

  return { channel: 'msedge' }
}

const browserLaunch = resolveBrowserLaunchConfig()
const e2eUserDataDir =
  process.env.ASHY_USER_DATA_DIR ??
  path.join(os.tmpdir(), `ashy-e2e-userdata-${Date.now()}-${process.pid}`)

export default defineConfig({
  testDir: './apps/desktop/e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: {
    timeout: 15_000,
  },
  use: {
    baseURL: 'http://127.0.0.1:5173',
    headless: true,
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    launchOptions: {
      ...(browserLaunch.executablePath
        ? { executablePath: browserLaunch.executablePath }
        : {}),
    },
    ...(browserLaunch.channel ? { channel: browserLaunch.channel } : {}),
  },
  webServer: {
    command: 'pnpm --filter @ashy/desktop dev --port 5173 --strictPort',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      ...process.env,
      ASHY_USER_DATA_DIR: e2eUserDataDir,
    },
  },
})
