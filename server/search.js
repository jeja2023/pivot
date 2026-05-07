/* Search helpers */

function buildFtsQuery(value) {
    const terms = String(value || '')
        .trim()
        .split(/\s+/)
        .map(term => term.replace(/"/g, '""'))
        .filter(Boolean)
        .slice(0, 8);

    return terms.map(term => `"${term}"`).join(' AND ');
}

module.exports = { buildFtsQuery };
