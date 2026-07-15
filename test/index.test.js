const App = require('../index');

describe('App definition', () => {
  test('exports required top-level fields', () => {
    expect(typeof App.version).toBe('string');
    expect(typeof App.platformVersion).toBe('string');
    expect(App.authentication).toBeDefined();
    expect(App.authentication.type).toBe('oauth2');
    expect(App.hydrators.downloadSubmissionPdf).toBeDefined();
    expect(App.triggers.submission).toBeDefined();
    expect(App.triggers.form_list).toBeDefined();
    expect(App.triggers.form_list.display.hidden).toBe(true);
  });

  test('beforeRequest injects OAuth Bearer header from access_token', () => {
    expect(Array.isArray(App.beforeRequest)).toBe(true);
    const hook = App.beforeRequest[0];
    const bundle = { authData: { access_token: 'fbo_access' } };
    const req = hook({ headers: {} }, {}, bundle);
    expect(req.headers.authorization).toBe('Bearer fbo_access');
  });

  test('beforeRequest does not overwrite an existing auth header', () => {
    const hook = App.beforeRequest[0];
    const bundle = { authData: { access_token: 'fbo_access' } };
    const req = hook({ headers: { authorization: 'Bearer keep' } }, {}, bundle);
    expect(req.headers.authorization).toBe('Bearer keep');
  });
});
