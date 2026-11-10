'use strict';

const runtime = require('../../server/services/policy-review/runtime');
const repository = require('../../server/repositories/policy-reviews');
const { modelResponse } = require('./policy-review');

(async () => {
    const user = await repository.actor(Number(process.argv[3]));
    let calls = 0;
    await runtime.run(user, process.argv[2], { callModel: async options => {
        if (++calls === 2) process.exit(37);
        const request = JSON.parse(options.messages[1].content);
        return { content: JSON.stringify(modelResponse(request, request.policyContext.filter(item => request.batchClauseIds.includes(item.id)))), usage: { totalTokens: 100 } };
    } });
    process.exit(1);
})().catch(() => process.exit(2));
