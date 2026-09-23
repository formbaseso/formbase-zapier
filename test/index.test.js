const App = require('../index')

describe('App definition', () => {
  test('exports the auth, hydrator, every trigger, every action and the search', () => {
    expect(typeof App.version).toBe('string')
    expect(typeof App.platformVersion).toBe('string')
    expect(App.authentication.type).toBe('oauth2')
    expect(App.hydrators.downloadSubmissionPdf).toBeDefined()
    expect(Object.keys(App.triggers).sort()).toEqual(['form_list', 'public_link_submission', 'request_canceled', 'request_completed', 'request_expired'])
    expect(App.triggers.form_list.display.hidden).toBe(true)
    expect(Object.keys(App.creates).sort()).toEqual(['cancel_request', 'create_request', 'get_request', 'remind_request'])
    expect(Object.keys(App.searches)).toEqual(['find_request'])
  })

  test('adds no request middleware: the RPC client sets its own Bearer header', () => {
    expect(App.beforeRequest).toBeUndefined()
    expect(App.afterResponse).toBeUndefined()
  })
})
