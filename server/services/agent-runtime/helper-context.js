'use strict';
const context = require('../request-context');
function withHelperBrowserContext(execute, getRunForUser) {
    return async (runId,user,execution = {}) => {
        const current = await getRunForUser(runId,user,{includeDeleted:true});
        return context.runWithRequestContext({...context.getRequestContext(),userId:user.id,helperBrowserKey:current?.helper_browser_key || ''},()=>execute(runId,user,execution));
    };
}
module.exports = {withHelperBrowserContext};
