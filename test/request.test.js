// BASE_URL is read at module load in utils/request, so set it before requiring.
process.env.BASE_URL = 'https://fake.formbase.test';

const nock = require('nock');
const { formbaseRpc } = require('../utils/request');

class RefreshAuthError extends Error {}
class ThrottledError extends Error {}

function makeZ() {
  return {
    request: async (opts) => {
      const https = require('https');
      const http = require('http');
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

describe('formbaseRpc', () => {
  afterEach(() => nock.cleanAll());

  test('posts to /api/v1 with the OAuth bearer token and returns data on ok', async () => {
    nock(FAKE_BASE)
      .post('/api/v1', { method: 'me.get', params: {} })
      .matchHeader('authorization', 'Bearer fbo_access')
      .matchHeader('content-type', 'application/json')
      .reply(200, { ok: true, data: { userId: 'u1', email: 'a@b.com', workspacesCount: 1 } });

    const z = makeZ();
    const bundle = { authData: { access_token: 'fbo_access' } };
    const result = await formbaseRpc({ z, bundle, method: 'me.get', params: {} });
    expect(result).toEqual({ userId: 'u1', email: 'a@b.com', workspacesCount: 1 });
  });

  test('defaults to https://api.formbase.so when BASE_URL is unset', async () => {
    const saved = process.env.BASE_URL;
    delete process.env.BASE_URL;
    let freshRpc;
    jest.isolateModules(() => {
      freshRpc = require('../utils/request').formbaseRpc;
    });

    nock('https://api.formbase.so')
      .post('/api/v1')
      .reply(200, { ok: true, data: { ok: true } });

    const result = await freshRpc({
      z: makeZ(),
      bundle: { authData: { access_token: 'fbo_x' } },
      method: 'forms.list',
      params: {},
    });
    expect(result).toEqual({ ok: true });

    process.env.BASE_URL = saved;
  });

  test('UNAUTHORIZED maps to RefreshAuthError', async () => {
    nock(FAKE_BASE)
      .post('/api/v1')
      .reply(401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'bad token' } });

    const z = makeZ();
    const bundle = { authData: { access_token: 'fbo_bad' } };
    await expect(formbaseRpc({ z, bundle, method: 'me.get', params: {} })).rejects.toBeInstanceOf(RefreshAuthError);
  });

  test('RATE_LIMITED maps to ThrottledError', async () => {
    nock(FAKE_BASE)
      .post('/api/v1')
      .reply(429, { ok: false, error: { code: 'RATE_LIMITED', message: 'slow down' } });

    const z = makeZ();
    const bundle = { authData: { access_token: 'fbo_x' } };
    await expect(formbaseRpc({ z, bundle, method: 'me.get', params: {} })).rejects.toBeInstanceOf(ThrottledError);
  });

  test('other errors throw plain Error with code+message', async () => {
    nock(FAKE_BASE)
      .post('/api/v1')
      .reply(400, { ok: false, error: { code: 'VALIDATION_ERROR', message: 'bad params' } });

    const z = makeZ();
    const bundle = { authData: { access_token: 'fbo_x' } };
    await expect(formbaseRpc({ z, bundle, method: 'me.get', params: {} })).rejects.toThrow(/VALIDATION_ERROR/);
  });
});
