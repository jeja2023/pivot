/* 桌面更新器与服务端页面共用错误文案，兼容旧客户端返回的原始错误。 */
(function (scope) {
    'use strict';
    const messages = Object.freeze({
        missingChannel: '更新服务尚未发布版本信息（latest.yml，HTTP 404），请联系管理员检查更新目录。',
        missingInstaller: '更新安装包不存在（HTTP 404），请联系管理员重新发布完整更新文件。',
        accessDenied: '更新服务拒绝访问，请联系管理员检查更新源访问权限。',
        signature: '更新安装包签名校验未通过，请联系管理员检查发布证书和客户端版本。',
        timeout: '检查或下载更新超时，请稍后重试；持续失败时请联系管理员。',
        connection: '无法连接更新服务，请检查单位内网连接后重试。',
        unavailable: '客户端更新暂时不可用，请稍后重试或联系管理员。'
    });

    function formatDesktopUpdateError(error) {
        const text = String(error?.message || error || '');
        const code = String(error?.code || '');
        if (Object.values(messages).includes(text)) return text;
        if (code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' || /Cannot find channel\s+["'][^"']+\.yml["']\s+update info/i.test(text)) return messages.missingChannel;
        if (error?.statusCode === 404 || /(?:HttpError:\s*|HTTP\s+)404\b/i.test(text)) return messages.missingInstaller;
        if ([401, 403].includes(error?.statusCode) || /(?:HttpError:\s*|HTTP\s+)(?:401|403)\b/i.test(text)) return messages.accessDenied;
        if (code === 'ERR_UPDATER_INVALID_SIGNATURE' || /Authenticode|签名.*(?:无效|失败|未通过)|指纹不匹配|not signed by|incorrect certificate/i.test(text)) return messages.signature;
        if (/ETIMEDOUT|ESOCKETTIMEDOUT|timed?\s*out|timeout|超时/i.test(code + ' ' + text)) return messages.timeout;
        if (/ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|ERR_(?:CONNECTION|NAME_NOT_RESOLVED)/i.test(code + ' ' + text)) return messages.connection;
        return messages.unavailable;
    }

    const api = { formatDesktopUpdateError };
    if (typeof module === 'object' && module.exports) module.exports = api;
    else scope.Pivot.exposeModule('chat.desktopUpdateErrors', api);
})(globalThis);
