// BASE_URL is read at module load in utils/request, so set it before requiring.
process.env.BASE_URL = 'https://fake.formbase.test';

const nock = require('nock');
const authentication = require('../authentication');

class RefreshAuthError extends Error {}
class ThrottledError extends Error {}

function makeZ() {
  const https = require('https');
  const http = require('http');
  return {
    request: async (opts) => {
      const url = new URL(opts.url);
      const lib = url.protocol === 'https:' ? https : http;
      return new Promise((resolve, reject) => {
        const req = lib.request(
          {
            method: opts.method || 'GET',
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: url.pathname + url.search,
            headers: opts.headers || {},
          },
          (res) => {
            let data = '';
            res.on('data', (c) => (data += c));
            res.on('end', () =>
              resolve({ status: res.statusCode, data, json: data ? JSON.parse(data) : null })
            );
          }
        );
        req.on('error', reject);
        if (opts.body) req.write(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
        req.end();
      });
    },
    errors: { RefreshAuthError, ThrottledError },
  };
}

const FAKE_BASE = process.env.BASE_URL;

describe('authentication', () => {
  afterEach(() => nock.cleanAll());

  test('shape is oauth2 with PKCE + autoRefresh + offline_access scope', () => {
    expect(authentication.type).toBe('oauth2');
    const cfg = authentication.oauth2Config;
    expect(cfg).toBeDefined();
    expect(cfg.enablePkce).toBe(true);
    expect(cfg.autoRefresh).toBe(true);
    expect(cfg.scope).toMatch(/offline_access/);
    expect(cfg.scope).toMatch(/api:read/);
    expect(cfg.scope).toMatch(/api:write/);
  });

  test('authorize / token / refresh URLs point at the configured base /oauth endpoints', () => {
    const cfg = authentication.oauth2Config;
    expect(cfg.authorizeUrl.url).toBe(`${FAKE_BASE}/oauth/authorize`);
    // client_id / state / redirect_uri / response_type are auto-appended by
    // Zapier; declaring client_id here lands it first as an empty value and
    // shadows Zapier's. Only scope is set explicitly.
    expect(cfg.authorizeUrl.params.client_id).toBeUndefined();
    expect(cfg.authorizeUrl.params.scope).toBe('api:read api:write offline_access');
    expect(cfg.getAccessToken.url).toBe(`${FAKE_BASE}/oauth/token`);
    expect(cfg.enablePkce).toBe(true);
    // Zapier does not merge into the token body, so we list every field —
    // including the PKCE code_verifier (omitting either grant_type or
    // code_verifier makes /oauth/token reject the exchange).
    expect(cfg.getAccessToken.body.grant_type).toBe('authorization_code');
    expect(cfg.getAccessToken.body.code_verifier).toBe('{{bundle.inputData.code_verifier}}');
    expect(cfg.getAccessToken.body.client_secret).toBe('{{process.env.CLIENT_SECRET}}');
    expect(cfg.refreshAccessToken.url).toBe(`${FAKE_BASE}/oauth/token`);
    expect(cfg.refreshAccessToken.body.grant_type).toBe('refresh_token');
  });

  test('connectionLabel uses email from test fn', () => {
    expect(authentication.connectionLabel).toMatch(/email/);
  });

  test('test() calls me.get with the OAuth access token and returns { id, email, name }', async () => {
    nock(FAKE_BASE)
      .post('/api/v1', { method: 'me.get', params: {} })
      .matchHeader('authorization', 'Bearer fbo_access')
      .reply(200, { ok: true, data: { id: 'u1', email: 'alice@example.com', name: 'Alice' } });

    const z = makeZ();
    const bundle = { authData: { access_token: 'fbo_access' } };
    const result = await authentication.test(z, bundle);
    expect(result.email).toBe('alice@example.com');
    expect(result.id).toBe('u1');
  });

  test('test() rejects with RefreshAuthError on 401 (triggers token refresh)', async () => {
    nock(FAKE_BASE)
      .post('/api/v1')
      .reply(401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'no' } });

    const z = makeZ();
    const bundle = { authData: { access_token: 'fbo_bad' } };
    await expect(authentication.test(z, bundle)).rejects.toBeInstanceOf(RefreshAuthError);
  });
});
