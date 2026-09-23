const App = require('../index')

describe('App definition', () => {
  test('exports the auth, hydrator and both triggers', () => {
    expect(typeof App.version).toBe('string')
    expect(typeof App.platformVersion).toBe('string')
    expect(App.authentication.type).toBe('oauth2')
    expect(App.hydrators.downloadSubmissionPdf).toBeDefined()
    expect(App.triggers.submission).toBeDefined()
    expect(App.triggers.form_list.display.hidden).toBe(true)
  })

  test('adds no request middleware: the RPC client sets its own Bearer header', () => {
    expect(App.beforeRequest).toBeUndefined()
    expect(App.afterResponse).toBeUndefined()
  })
})
