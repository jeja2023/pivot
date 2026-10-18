'use strict';

function createReleaseAccessFilters({ resolveAccessSubjects, evaluateSkillReleaseAccess }) {
    async function filterAccessibleReleases(releases, user, action = 'use') {
        const rows = Array.isArray(releases) ? releases : [];
        if (!rows.length) return [];
        const subjects = await resolveAccessSubjects(user);
        const decisions = await Promise.all(rows.map(release => evaluateSkillReleaseAccess({ user, release, action, subjects })));
        return rows.filter((_release, index) => decisions[index]?.allowed === true);
    }

    async function filterAccessibleReleasesAny(releases, user, actions = ['use']) {
        const rows = Array.isArray(releases) ? releases : [];
        if (!rows.length) return [];
        const subjects = await resolveAccessSubjects(user);
        const requiredActions = Array.isArray(actions) && actions.length ? actions : ['use'];
        const decisions = await Promise.all(rows.map(release => Promise.all(
            requiredActions.map(action => evaluateSkillReleaseAccess({ user, release, action, subjects }))
        )));
        return rows.filter((_release, index) => decisions[index].some(item => item?.allowed === true));
    }
    return { filterAccessibleReleases, filterAccessibleReleasesAny };
}

module.exports = { createReleaseAccessFilters };

