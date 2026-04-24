const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
    testDir: './tests',
    use: {
        baseURL: 'http://localhost:3999',
    },
    webServer: {
        command: 'python3 -m http.server 3999 --directory docs',
        port: 3999,
        reuseExistingServer: true,
    },
    projects: [
        { name: 'chromium', use: { browserName: 'chromium' } },
    ],
});
