const baseURL = process.env.PIVOT_E2E_BASE_URL || 'http://127.0.0.1:3000';

module.exports = {
    testDir: __dirname,
    outputDir: process.env.PIVOT_E2E_OUTPUT_DIR,
    timeout: 30_000,
    retries: process.env.CI ? 1 : 0,
    use: {
        baseURL,
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure'
    },
    webServer: process.env.PIVOT_E2E_SKIP_WEBSERVER === 'true' ? undefined : {
        command: 'npm run start',
        url: baseURL,
        reuseExistingServer: true,
        timeout: 60_000
    }
};
