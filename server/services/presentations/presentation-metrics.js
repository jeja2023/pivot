'use strict';

const DEFAULT_BUCKETS_MS = Object.freeze([50, 100, 250, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000, 180000]);
const counters = new Map();
const histograms = new Map();

function key(name, labels = {}) { return name + '|' + Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => k + '=' + String(v)).join('|'); }
function normalizeLabels(labels = {}) { return Object.fromEntries(Object.entries(labels).map(([k, v]) => [String(k).slice(0, 64), String(v).slice(0, 128)])); }

function recordPresentationCount(name, labels = {}, increment = 1) {
    const normalized = normalizeLabels(labels); const id = key(name, normalized);
    const item = counters.get(id) || { name, labels: normalized, value: 0 }; item.value += Number(increment) || 0; counters.set(id, item);
}

function recordPresentationDuration(name, durationMs, labels = {}, buckets = DEFAULT_BUCKETS_MS) {
    const normalized = normalizeLabels(labels); const id = key(name, normalized);
    const item = histograms.get(id) || { name, labels: normalized, count: 0, sumMs: 0, buckets: buckets.map(limit => ({ limit, count: 0 })) };
    const value = Math.max(0, Number(durationMs) || 0); item.count += 1; item.sumMs += value; item.buckets.forEach(bucket => { if (value <= bucket.limit) bucket.count += 1; }); histograms.set(id, item);
}

function recordPresentationOutcome(operation, { outcome = 'success', durationMs = null, format = '', source = '' } = {}) {
    const labels = { operation, outcome, ...(format ? { format } : {}), ...(source ? { source } : {}) };
    recordPresentationCount('pivot_presentation_operations_total', labels);
    if (durationMs !== null && durationMs !== undefined) recordPresentationDuration('pivot_presentation_operation_duration_ms', durationMs, { operation, ...(format ? { format } : {}), ...(source ? { source } : {}) });
}

function getPresentationMetricsSnapshot() {
    return { counters: [...counters.values()].map(item => ({ ...item })), histograms: [...histograms.values()].map(item => ({ name: item.name, labels: { ...item.labels }, count: item.count, sumMs: item.sumMs, buckets: item.buckets.map(bucket => ({ ...bucket })) })) };
}

module.exports = { getPresentationMetricsSnapshot, recordPresentationOutcome };
