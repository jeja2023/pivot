'use strict';

/**
 * 演示文稿在线状态注册表（In-Memory Presence Registry）
 *
 * 管理当前正在查看或编辑同一文稿的协作者在线状态、所在幻灯片与活动标识。
 * 45 秒内未接收到心跳的会话自动摘除，避免常驻脏数据。
 */
const { getBeijingTimestamp } = require('../../time');

const PRESENCE_TTL_MS = 45000;
const presenceStore = new Map(); // presentationId -> Map<userId, PresenceEntry>

function pruneStale(userMap) {
    const now = Date.now();
    for (const [userId, entry] of userMap.entries()) {
        if (now - entry.timestamp > PRESENCE_TTL_MS) {
            userMap.delete(userId);
        }
    }
}

function recordPresence({ presentationId, user, slideId = '', selectedElementId = '', isEditing = false } = {}) {
    const pId = String(presentationId || '').trim();
    const uId = Number(user?.id);
    if (!pId || !uId) return [];

    let userMap = presenceStore.get(pId);
    if (!userMap) {
        userMap = new Map();
        presenceStore.set(pId, userMap);
    }
    pruneStale(userMap);

    const displayName = String(user?.nickname || user?.username || '用户').slice(0, 60);
    const username = String(user?.username || '').slice(0, 60);

    userMap.set(uId, {
        userId: uId,
        username,
        displayName,
        slideId: String(slideId || '').slice(0, 64),
        selectedElementId: String(selectedElementId || '').slice(0, 64),
        isEditing: Boolean(isEditing),
        lastSeenAt: getBeijingTimestamp(),
        timestamp: Date.now()
    });

    return listActivePresence(pId);
}

function listActivePresence(presentationId) {
    const pId = String(presentationId || '').trim();
    if (!pId) return [];

    const userMap = presenceStore.get(pId);
    if (!userMap) return [];
    pruneStale(userMap);
    if (userMap.size === 0) {
        presenceStore.delete(pId);
        return [];
    }

    return Array.from(userMap.values()).map(item => ({
        userId: item.userId,
        username: item.username,
        displayName: item.displayName,
        slideId: item.slideId,
        selectedElementId: item.selectedElementId,
        isEditing: item.isEditing,
        lastSeenAt: item.lastSeenAt
    }));
}

function leavePresence({ presentationId, user } = {}) {
    const pId = String(presentationId || '').trim();
    const uId = Number(user?.id);
    if (!pId || !uId) return [];

    const userMap = presenceStore.get(pId);
    if (!userMap) return [];
    userMap.delete(uId);
    if (userMap.size === 0) {
        presenceStore.delete(pId);
        return [];
    }
    return listActivePresence(pId);
}

function resetAllPresence() {
    presenceStore.clear();
}

module.exports = {
    recordPresence,
    listActivePresence,
    leavePresence,
    resetAllPresence
};
