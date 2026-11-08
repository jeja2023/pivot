/* global window */
'use strict';

const { test, expect } = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Client } = require('pg');

test('共享收紧已提交而独立确认中断时，真实共享面板显示已生效待确认并可在恢复后继续使用', async ({ page }) => {
    test.setTimeout(90000);
    assert.equal(process.env.PIVOT_E2E_ISOLATED, 'true');
    assert.match(process.env.PG_TEST_SCHEMA, /^pivot_e2e_[a-z0-9_]+$/);
    assert.ok(path.isAbsolute(process.env.DATA_ANALYSIS_SECURITY_KEY_FILE));
    const client = new Client({ connectionString: process.env.DATABASE_URL, options: `-c search_path="${process.env.PG_TEST_SCHEMA}",public` });
    await client.connect();
    let locked = false, renamed = false;
    const key = process.env.DATA_ANALYSIS_SECURITY_KEY_FILE;
    try {
        await page.goto('/chat', { waitUntil: 'domcontentloaded' });
        if (await page.locator('#username').isVisible()) {
            await page.locator('#username').fill('admin'); await page.locator('#password').fill(process.env.DEFAULT_ADMIN_PASSWORD || 'E2eAdmin123'); await page.locator('#auth-submit').click();
        }
        await expect(page.locator('#auth-container')).toBeHidden({ timeout: 15000 });
        await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAppsWorkbench?.());
        await page.evaluate(async () => { await window.Pivot.loadScriptOnce('/chat/apps-workbench-data-analysis.js'); await window.Pivot.legacy.showDataAnalysisApp({ tab: 'overview' }); });
        await page.locator('#data-analysis-file').setInputFiles({ name: 'security-confirmation.csv', mimeType: 'text/csv', buffer: Buffer.from('账号,金额\na,25.00\n', 'utf8') });
        await expect(page.locator('#data-analysis-dataset-table-body')).toContainText('security-confirmation', { timeout: 20000 });
        const datasetId = await page.evaluate(async () => {
            const app = window.Pivot.legacy.PivotDataAnalysis, dataset = app.state.datasets.find(item => item.name === 'security-confirmation');
            await app.fetchJson(`${app.API}/datasets/${encodeURIComponent(dataset.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope: 'shared', allowedUnits: '', allowedUserIds: '' }) });
            await app.loadDatasets(); return dataset.id;
        });
        await page.locator('[data-data-analysis-tab="governance"]').click();
        await page.locator('#data-analysis-governance-dataset').selectOption(datasetId);
        await page.locator('#data-analysis-open-share-modal').click();
        await expect(page.locator('#data-analysis-dataset-share-modal')).toBeVisible();
        await client.query(`CREATE FUNCTION pivot_e2e_security_write_pause() RETURNS trigger LANGUAGE plpgsql AS $body$
            BEGIN PERFORM pg_advisory_xact_lock(hashtext('pivot:e2e:security-confirmation'),hashtext(current_schema())); RETURN NEW; END $body$;
            CREATE TRIGGER zz_pivot_e2e_security_write_pause BEFORE UPDATE ON analysis_datasets FOR EACH ROW EXECUTE FUNCTION pivot_e2e_security_write_pause()`);
        await client.query("SELECT pg_advisory_lock(hashtext('pivot:e2e:security-confirmation'),hashtext(current_schema()))"); locked = true;
        const response = page.waitForResponse(value => value.request().method() === 'PATCH' && value.url().endsWith(`/datasets/${datasetId}`));
        await page.locator('#data-analysis-dataset-share-modal-save-btn').click();
        await expect.poll(async () => Number((await client.query("SELECT COUNT(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND query LIKE '%UPDATE analysis_datasets%'")).rows[0].n)).toBeGreaterThan(0);
        await fs.rename(key, `${key}.e2e-unavailable`); renamed = true;
        await client.query("SELECT pg_advisory_unlock(hashtext('pivot:e2e:security-confirmation'),hashtext(current_schema()))"); locked = false;
        const failed = await response; expect(failed.status()).toBe(503);
        expect(await failed.json()).toMatchObject({ code: 'ANALYSIS_SECURITY_COMMITTED_PENDING', applied: true, securityConfirmationPending: true });
        await expect(page.locator('#data-analysis-dataset-share-modal-error')).toContainText('权限已收紧，安全记录待持久确认');
        expect((await client.query('SELECT scope FROM analysis_datasets WHERE id=$1', [datasetId])).rows[0].scope).toBe('personal');
        const root = path.resolve(__dirname, '../../output/bi-modeling'); await fs.mkdir(root, { recursive: true });
        await page.screenshot({ path: path.join(root, 'security-confirmation-pending.png'), fullPage: true });
        await fs.rename(`${key}.e2e-unavailable`, key); renamed = false;
        await expect.poll(async () => Number((await client.query('SELECT COUNT(*) AS n FROM analysis_security_outbox WHERE target_id=$1 AND acknowledged_at IS NULL', [datasetId])).rows[0].n), { timeout: 10000 }).toBe(0);
        await page.locator('#data-analysis-dataset-share-modal-save-btn').click();
        await expect(page.locator('#data-analysis-dataset-share-modal')).toBeHidden();
        const current = await page.evaluate(async id => { const app = window.Pivot.legacy.PivotDataAnalysis; return app.fetchJson(`${app.API}/datasets/${encodeURIComponent(id)}`); }, datasetId);
        expect(current.dataset.scope).toBe('personal');
    } finally {
        if (renamed) await fs.rename(`${key}.e2e-unavailable`, key);
        if (locked) await client.query("SELECT pg_advisory_unlock(hashtext('pivot:e2e:security-confirmation'),hashtext(current_schema()))");
        await client.query('DROP TRIGGER IF EXISTS zz_pivot_e2e_security_write_pause ON analysis_datasets; DROP FUNCTION IF EXISTS pivot_e2e_security_write_pause()');
        await client.end();
    }
});
