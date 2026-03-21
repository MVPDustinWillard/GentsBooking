const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  timeout: 20000,
  retries: 1,
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: {
    baseURL: 'http://localhost:3000',
    headless: true,
    ignoreHTTPSErrors: true,
  },
  workers: 1,
});
