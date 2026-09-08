const INITIAL_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 60 * 1000;

function calculateAgentRetryDelayMs(retryAttempt, random = Math.random) {
    const attempt = Math.max(1, Number.parseInt(retryAttempt, 10) || 1);
    const base = Math.min(INITIAL_RETRY_DELAY_MS * (2 ** (attempt - 1)), MAX_RETRY_DELAY_MS);
    const jitter = Math.floor(base * 0.2 * Math.max(0, Math.min(Number(random()) || 0, 1)));
    return Math.min(base + jitter, MAX_RETRY_DELAY_MS);
}

module.exports = { INITIAL_RETRY_DELAY_MS, MAX_RETRY_DELAY_MS, calculateAgentRetryDelayMs };
