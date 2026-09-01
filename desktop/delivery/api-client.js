/**
 * desktop/delivery/api-client.js
 * 交付控制面 HTTP 客户端（落地方案 v1.2 §7.4 意图→领取→确认、§7.6 桌面端写入）
 *
 * 只负责按既有服务端契约拼装请求与解析响应，传输层通过 request 注入，
 * 便于在纯 node 环境下用假实现校验执行器逻辑。所有端点都在 /api 前缀下且需要会话鉴权。
 */
const API_PREFIX = '/api';

function apiError(message, code = 'DELIVERY_API_FAILED', status = 0) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    return error;
}

function assertOk(response, fallbackMessage) {
    const status = Number(response && response.status) || 0;
    if (status >= 200 && status < 300) return response;
    const data = response && response.data && typeof response.data === 'object' ? response.data : {};
    const message = String(data.error || data.message || fallbackMessage);
    throw apiError(message, String(data.code || 'DELIVERY_API_FAILED'), status);
}

function createDeliveryApiClient({ request } = {}) {
    if (typeof request !== 'function') throw apiError('缺少交付传输层实现。', 'DELIVERY_TRANSPORT_REQUIRED');

    async function call(method, endpoint, options = {}) {
        const response = await request({
            method,
            path: `${API_PREFIX}${endpoint}`,
            body: options.body,
            query: options.query,
            stream: options.stream === true,
            timeoutMs: options.timeoutMs
        });
        return assertOk(response, options.fallbackMessage || '交付控制面请求失败。');
    }

    return {
        /** 申请一次性挑战值：purpose 取 register / attest / claim / grant。 */
        async challenge(purpose, deviceId) {
            const response = await call('POST', '/agents/local-devices/challenge', {
                body: { purpose, deviceId: deviceId || undefined },
                fallbackMessage: '获取设备挑战值失败。'
            });
            const nonce = String(response.data && response.data.nonce ? response.data.nonce : '');
            if (!nonce) throw apiError('服务端未返回设备挑战值。', 'DELIVERY_CHALLENGE_MISSING');
            return { nonce, expiresAt: String(response.data.expiresAt || '') };
        },

        /** 首次配对或密钥轮换：只上传公钥，私钥永不出本机。 */
        async registerDevice(payload) {
            const response = await call('POST', '/agents/local-devices', {
                body: payload,
                fallbackMessage: '注册本机交付设备失败。'
            });
            return response.data && response.data.device ? response.data.device : null;
        },

        /** 心跳并证明身份，未持有私钥的客户端无法通过。 */
        async attest(deviceId, payload) {
            const response = await call('POST', `/agents/local-devices/${encodeURIComponent(deviceId)}/attest`, {
                body: payload,
                fallbackMessage: '设备心跳失败。'
            });
            return response.data && response.data.device ? response.data.device : null;
        },

        async registerOutputGrant(deviceId, payload) {
            const response = await call('POST', `/agents/local-devices/${encodeURIComponent(deviceId)}/output-grants`, {
                body: payload,
                fallbackMessage: '登记本机写入目录授权失败。'
            });
            return response.data && response.data.grant ? response.data.grant : null;
        },

        async revokeOutputGrant(grantId) {
            const response = await call('DELETE', `/agents/output-grants/${encodeURIComponent(grantId)}`, {
                fallbackMessage: '撤销本机写入目录授权失败。'
            });
            return response.data && response.data.grant ? response.data.grant : null;
        },

        /** 领取交付意图：服务端先校验设备签名，再进入意图状态机。 */
        async claim(payload) {
            const response = await call('POST', '/agents/deliveries/claim', {
                body: payload,
                fallbackMessage: '领取交付意图失败。'
            });
            return response.data && typeof response.data === 'object' ? response.data : {};
        },

        async confirm(intentId, payload) {
            const response = await call('POST', `/agents/deliveries/${encodeURIComponent(intentId)}/confirm`, {
                body: payload,
                fallbackMessage: '回执交付结果失败。'
            });
            return response.data && response.data.intent ? response.data.intent : null;
        },

        async fail(intentId, payload) {
            const response = await call('POST', `/agents/deliveries/${encodeURIComponent(intentId)}/fail`, {
                body: payload,
                fallbackMessage: '上报交付失败结果失败。'
            });
            return response.data && response.data.intent ? response.data.intent : null;
        },

        /** 兑换一次性下载令牌并取回字节流。 */
        async downloadRendition(renditionId, token, deviceId, proof = {}) {
            const response = await call('GET', `/agents/renditions/${encodeURIComponent(renditionId)}/download`, {
                query: {
                    token,
                    deviceId: deviceId || undefined,
                    nonce: proof.nonce || undefined,
                    signature: proof.signature || undefined
                },
                stream: true,
                fallbackMessage: '拉取渲染产物字节流失败。'
            });
            return { body: response.body, headers: response.headers || {}, status: response.status };
        }
    };
}

module.exports = { createDeliveryApiClient };
