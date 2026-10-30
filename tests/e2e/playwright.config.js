const baseURL = process.env.PIVOT_E2E_BASE_URL || 'http://127.0.0.1:3000';

module.exports = {
    testDir: __dirname,
    outputDir: process.env.PIVOT_E2E_OUTPUT_DIR,
    timeout: 30_000,
    retries: process.env.CI ? 1 : 0,
    workers: process.env.PIVOT_E2E_WORKERS ? Number(process.env.PIVOT_E2E_WORKERS) : 1,
    use: {
        baseURL,
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure'
    },
    webServer: process.env.PIVOT_E2E_SKIP_WEBSERVER === 'true' ? undefined : {
        command: 'npm run start',
        // 同步数据库适配层只供测试夹具使用；被测服务走正常异步路径。
        env: { PIVOT_TEST_PG_SYNC: 'false' },
        url: baseURL,
        reuseExistingServer: process.env.PIVOT_E2E_ISOLATED !== 'true',
        timeout: 60_000
    }
};
