import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 90000,
  expect: { timeout: 15000 },
  fullyParallel: false,
  workers: 2,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    locale: 'it-IT',
    trace: 'off'
  },
  webServer: {
    command: 'node tests/server.js',
    url: 'http://127.0.0.1:4173/index.html',
    reuseExistingServer: true,
    timeout: 30000
  },
  projects: [
    { name: 'phone-360', use: { ...devices['Desktop Chrome'], viewport: { width: 360, height: 640 } } },
    { name: 'phone-390', use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 } } },
    { name: 'tablet-768', use: { ...devices['Desktop Chrome'], viewport: { width: 768, height: 1024 } } },
    { name: 'desktop-1280', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } }
  ]
});
