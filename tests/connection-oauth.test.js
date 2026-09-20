'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { formEncode, oauthConfig, pkceChallenge, selectRedirectUri, isAllowedOAuthUrl } = require('../server/services/connection-oauth');

test('OAuth PKCE verifier challenge is deterministic and authorization URLs require registered redirects', () => {
    assert.equal(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    const config = oauthConfig({
        config: { authorizationUrl: 'https://login.example.com/authorize', tokenUrl: 'https://login.example.com/token', clientId: 'client-1', redirectUris: ['https://pivot.example.com/api/connection-accounts/oauth/callback'] },
        default_scopes: ['read']
    });
    assert.equal(selectRedirectUri(config), 'https://pivot.example.com/api/connection-accounts/oauth/callback');
    assert.throws(() => selectRedirectUri(config, { redirectUri: 'https://attacker.example/callback' }), error => error.code === 'CONNECTION_OAUTH_REDIRECT_INVALID');
    assert.equal(isAllowedOAuthUrl('https://login.example.com/token'), true);
    assert.equal(isAllowedOAuthUrl('http://login.example.com/token'), false);
    assert.equal(formEncode({ grant_type: 'authorization_code', code: 'a b', absent: '' }), 'grant_type=authorization_code&code=a+b');
});
