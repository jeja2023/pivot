const MIN_PASSWORD_LENGTH = 10;
const COMMON_PASSWORDS = new Set([
    'password123', 'password123!', 'admin123456', 'admin123456!',
    'welcome123', 'welcome123!', 'qwerty123', 'qwerty123!'
]);
const PASSWORD_RULE_DESCRIPTION = `至少 ${MIN_PASSWORD_LENGTH} 位，并同时包含大写字母、小写字母和数字，且不得使用常见口令`;

function getPasswordValidationMessage(password) {
    const text = String(password || '');
    if (!text) return `请输入密码。密码要求：${PASSWORD_RULE_DESCRIPTION}。`;
    const missing = [];
    if (text.length < MIN_PASSWORD_LENGTH) missing.push(`至少 ${MIN_PASSWORD_LENGTH} 位`);
    if (!/[A-Z]/.test(text)) missing.push('包含大写字母');
    if (!/[a-z]/.test(text)) missing.push('包含小写字母');
    if (!/[0-9]/.test(text)) missing.push('包含数字');
    if (COMMON_PASSWORDS.has(text.toLowerCase())) missing.push('不得使用常见口令');
    if (missing.length === 0) return '';
    return `密码不符合要求：请确保${missing.join('、')}。完整规则：${PASSWORD_RULE_DESCRIPTION}。`;
}

function assertValidPassword(password) {
    const message = getPasswordValidationMessage(password);
    if (!message) return;
    const error = new Error(message);
    error.status = 400;
    throw error;
}

module.exports = {
    COMMON_PASSWORDS,
    MIN_PASSWORD_LENGTH,
    PASSWORD_RULE_DESCRIPTION,
    assertValidPassword,
    getPasswordValidationMessage
};
