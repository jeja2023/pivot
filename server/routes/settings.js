/* 系统设置路由 System Settings Routes */
const express = require('express');
const db = require('../db');
const { asyncHandler } = require('../http');
const { getBeijingTimestamp } = require('../time');

const allowedSettings = new Set(['rag_enabled', 'default_model_id']);

const toSettingValue = (key, value) => {
    if (value === null || value === undefined || value === '') {
        return '';
    }
    if (key === 'rag_enabled') {
        return value === true || value === 'true' || value === 1 || value === '1' ? 'true' : 'false';
    }
    return String(value);
};

function getSettings() {
    const rows = db.prepare('SELECT key, value, updated_at, updated_by FROM app_settings').all();
    const settings = {};
    rows.forEach(row => {
        settings[row.key] = {
            value: row.value,
            enabled: row.value === 'true',
            updatedAt: row.updated_at,
            updatedBy: row.updated_by
        };
    });
    return settings;
}

function createSettingsRouter({ authMiddleware, adminMiddleware, logAction }) {
    const router = express.Router();

    router.get('/settings', authMiddleware, (req, res) => {
        const settings = getSettings();
        res.json({
            ragEnabled: settings.rag_enabled?.value === 'true',
            defaultModelId: settings.default_model_id?.value || null,
            personalDefaultModelId: req.user?.default_model_id || null,
            settings
        });
    });

    router.put('/settings/default-model', authMiddleware, asyncHandler(async (req, res) => {
        const rawModelId = req.body?.default_model_id;
        const parsedModelId = rawModelId === null || rawModelId === undefined || rawModelId === ''
            ? null
            : Number.parseInt(rawModelId, 10);

        if (parsedModelId !== null && (!Number.isInteger(parsedModelId) || parsedModelId <= 0)) {
            return res.status(400).json({ error: '默认模型参数无效' });
        }

        if (parsedModelId !== null) {
            const sql = req.user.role === 'admin'
                ? 'SELECT id FROM models WHERE id = ?'
                : 'SELECT id FROM models WHERE id = ? AND (user_id = ? OR user_id IS NULL)';
            const model = req.user.role === 'admin'
                ? db.prepare(sql).get(parsedModelId)
                : db.prepare(sql).get(parsedModelId, req.user.id);
            if (!model) {
                return res.status(400).json({ error: '只能将您可访问的模型设为默认' });
            }
        }

        db.prepare('UPDATE users SET default_model_id = ? WHERE id = ?').run(parsedModelId, req.user.id);
        const changed = parsedModelId === null ? '清空个人默认模型' : `模型ID: ${parsedModelId}`;
        logAction(req, '修改个人默认模型', changed);
        res.json({ success: true, personalDefaultModelId: parsedModelId });
    }));

    router.put('/admin/settings', authMiddleware, adminMiddleware, asyncHandler(async (req, res) => {
        const updates = req.body || {};
        const stmt = db.prepare(`
            INSERT INTO app_settings (key, value, updated_at, updated_by)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET
                value = excluded.value,
                updated_at = excluded.updated_at,
                updated_by = excluded.updated_by
        `);

        const changed = [];
        Object.keys(updates).forEach(key => {
            if (!allowedSettings.has(key)) return;
            const value = toSettingValue(key, updates[key]);
            if (key === 'default_model_id' && value) {
                const globalModel = db.prepare('SELECT id FROM models WHERE id = ? AND user_id IS NULL').get(value);
                if (!globalModel) {
                    throw new Error('系统默认模型只能选择全局模型，不能选择用户私有模型');
                }
            }
            stmt.run(key, value, getBeijingTimestamp(), req.user.id);
            changed.push(`${key}=${value}`);
        });

        if (changed.length > 0) {
            logAction(req, '修改系统设置', changed.join('，'));
        }

        const settings = getSettings();
        res.json({
            success: true,
            ragEnabled: settings.rag_enabled?.value === 'true',
            defaultModelId: settings.default_model_id?.value || null,
            personalDefaultModelId: req.user?.default_model_id || null,
            settings
        });
    }));

    return router;
}

function isSettingEnabled(key) {
    const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
    return row?.value === 'true';
}

module.exports = {
    createSettingsRouter,
    isSettingEnabled
};
