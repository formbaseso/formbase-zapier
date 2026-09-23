// BASE_URL is read at module load in utils/request, so set it before requiring.
process.env.BASE_URL = 'https://fake.formbase.test'

const nock = require('nock')
const authentication = require('../authentication')
const { makeZ, RefreshAuthError } = require('./helpers')

const FAKE_BASE = process.env.BASE_URL

describe('authentication', () => {
  afterEach(() => nock.cleanAll())

  test('shape is oauth2 with PKCE + autoRefresh + offline_access scope', () => {
    expect(authentication.type).toBe('oauth2')
    const cfg = authentication.oauth2Config
    expect(cfg.enablePkce).toBe(true)
    expect(cfg.autoRefresh).toBe(true)
    expect(cfg.scope).toBe('api:read api:write offline_access')
  })

  test('authorize / token / refresh URLs point at the configured base /oauth endpoints', () => {
    const cfg = authentication.oauth2Config
    expect(cfg.authorizeUrl.url).toBe(`${FAKE_BASE}/oauth/authorize`)
    // client_id / state / redirect_uri / response_type are auto-appended by
    // Zapier; declaring client_id here lands it first as an empty value and
    // shadows Zapier's. Only scope is set explicitly.
    expect(cfg.authorizeUrl.params).toEqual({ scope: 'api:read api:write offline_access' })
    expect(cfg.getAccessToken.url).toBe(`${FAKE_BASE}/oauth/token`)
    // Zapier does not merge into the token body, so we list every field —
    // including the PKCE code_verifier (omitting either grant_type or
    // code_verifier makes /oauth/token reject the exchange).
    expect(cfg.getAccessToken.body.grant_type).toBe('authorization_code')
    expect(cfg.getAccessToken.body.code_verifier).toBe('{{bundle.inputData.code_verifier}}')
    expect(cfg.getAccessToken.body.client_secret).toBe('{{process.env.CLIENT_SECRET}}')
    expect(cfg.refreshAccessToken.url).toBe(`${FAKE_BASE}/oauth/token`)
    expect(cfg.refreshAccessToken.body.grant_type).toBe('refresh_token')
  })

  test('connectionLabel uses email from the test call', () => {
    expect(authentication.connectionLabel).toBe('{{email}}')
  })

  test('test() calls me.get with the OAuth access token and returns { id, email, name }', async () => {
    nock(FAKE_BASE)
      .post('/api/v1', { method: 'me.get', params: {} })
      .matchHeader('authorization', 'Bearer fbo_access')
      .reply(200, { ok: true, data: { id: 'u1', email: 'alice@example.com', name: 'Alice' } })

    const result = await authentication.test(makeZ(), { authData: { access_token: 'fbo_access' } })
    expect(result).toEqual({ id: 'u1', email: 'alice@example.com', name: 'Alice' })
  })

  test('test() rejects with RefreshAuthError on 401 (triggers token refresh)', async () => {
    nock(FAKE_BASE).post('/api/v1').reply(401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'no' } })

    await expect(authentication.test(makeZ(), { authData: { access_token: 'fbo_bad' } })).rejects.toBeInstanceOf(RefreshAuthError)
  })
})
