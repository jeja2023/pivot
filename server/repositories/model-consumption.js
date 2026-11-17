// @ts-check
'use strict';
const { queryOne } = require('../db/client');

/** 读取北京时间当天累计消费。 @param {number} userId @param {number} modelId @param {string} day */
async function dailyUsage(userId, modelId, day) {
    const row = await queryOne('SELECT token_count FROM model_daily_consumption WHERE user_id = ? AND model_id = ? AND usage_day = ?::date', [userId, modelId, day]);
    return Number(row?.token_count || 0);
}

module.exports = { dailyUsage };
