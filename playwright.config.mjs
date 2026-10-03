import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser',
  use: { baseURL: 'http://127.0.0.1:4173', channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true },
  globalSetup: './tests/browser/setup.mjs',
});
