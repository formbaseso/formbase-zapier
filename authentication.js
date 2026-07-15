'use strict'

const { formbaseRpc, BASE_URL } = require('./utils/request')

// Scopes requested at authorize time. `api:read`/`api:write` grant access to
// the /api/v1 surface this integration uses; `offline_access` is required for
// Zapier to receive (and rotate) a refresh token so connections survive past
// the 1-hour access-token TTL.
const SCOPE = 'api:read api:write offline_access'

async function test(z, bundle) {
  // me.get returns { id, email, name }; the returned object is what
  // connectionLabel "{{email}}" interpolates against.
  return formbaseRpc({ z, bundle, method: 'me.get', params: {} })
}

const authentication = {
  type: 'oauth2',
  oauth2Config: {
    // PKCE (S256) is mandatory: formbase's /oauth/authorize rejects requests
    // without code_challenge. enablePkce makes Zapier append code_challenge /
    // code_challenge_method here and code_verifier at token exchange.
    enablePkce: true,
    // Re-fetch a fresh access token via refresh_token on a 401
    // (utils/request throws RefreshAuthError on UNAUTHORIZED).
    autoRefresh: true,
    scope: SCOPE,
    authorizeUrl: {
      url: `${BASE_URL}/oauth/authorize`,
      // Zapier auto-appends client_id, state, redirect_uri and response_type
      // from the stored OAuth credentials — do NOT set client_id here or it
      // lands first as an empty value and shadows Zapier's (server reads the
      // first occurrence). Only scope needs to be declared explicitly.
      params: {
        scope: SCOPE,
      },
    },
    getAccessToken: {
      method: 'POST',
      url: `${BASE_URL}/oauth/token`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      // Unlike authorizeUrl (where Zapier merges in client_id/state/PKCE), the
      // token body is fully controlled by us — Zapier does NOT inject anything,
      // so EVERY field must be listed, including the PKCE code_verifier. Omit
      // grant_type → "grant_type <missing>"; omit code_verifier → "code_verifier
      // required". enablePkce exposes the verifier as bundle.inputData.code_verifier.
      body: {
        grant_type: 'authorization_code',
        code: '{{bundle.inputData.code}}',
        code_verifier: '{{bundle.inputData.code_verifier}}',
        redirect_uri: '{{bundle.inputData.redirect_uri}}',
        client_id: '{{process.env.CLIENT_ID}}',
        client_secret: '{{process.env.CLIENT_SECRET}}',
      },
    },
    refreshAccessToken: {
      method: 'POST',
      url: `${BASE_URL}/oauth/token`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: {
        grant_type: 'refresh_token',
        refresh_token: '{{bundle.authData.refresh_token}}',
        client_id: '{{process.env.CLIENT_ID}}',
        client_secret: '{{process.env.CLIENT_SECRET}}',
      },
    },
  },
  test,
  connectionLabel: '{{email}}',
}

module.exports = authentication
