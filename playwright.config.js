const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  timeout: 30000,
  use: { baseURL: 'http://127.0.0.1:8080', headless: true },
  webServer: {
    command: "node -e \"process.env.PORT='8080'; require('./server.js');\"",
    url: 'http://127.0.0.1:8080',
    reuseExistingServer: true,
    timeout: 30000
  }
});
