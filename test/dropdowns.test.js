// BASE_URL is read at module load in utils/request, so set it before requiring.
process.env.BASE_URL = 'https://fake.formbase.test'

const nock = require('nock')
const { listForms, listRequests } = require('../utils/dropdowns')
const cancel = require('../creates/cancel_request')
const { makeZ } = require('./helpers')

const FAKE_BASE = process.env.BASE_URL
const authData = { access_token: 'fbo_access' }

function rpc(method, predicate = () => true) {
  return nock(FAKE_BASE).post('/api/v1', (body) => {
    if (body.method !== method) return false
    return predicate(body.params)
  })
}

function workspace() {
  return rpc('workspaces.list').reply(200, { ok: true, data: { items: [{ id: 'ws_1', name: 'Acme', role: 'owner' }], hasMore: false } })
}

afterEach(() => nock.cleanAll())

describe('listForms (the form picker)', () => {
  test('lists every form of the token workspace, following the cursor across pages', async () => {
    workspace()
    rpc('forms.list', (params) => params.workspaceId === 'ws_1' && params.limit === 100 && params.cursor === undefined).reply(200, {
      ok: true,
      data: { items: [{ id: 'f1', name: 'Form A', workspaceId: 'ws_1', isPublished: true }], nextCursor: 'c2', hasMore: true },
    })
    rpc('forms.list', (params) => params.cursor === 'c2').reply(200, {
      ok: true,
      data: { items: [{ id: 'f2', name: 'Form B', workspaceId: 'ws_1', isPublished: false }], nextCursor: null, hasMore: false },
    })

    await expect(listForms(makeZ(), { authData })).resolves.toEqual([
      { id: 'f1', label: 'Form A' },
      { id: 'f2', label: 'Form B (not published)' },
    ])
  })

  test('fails when the connection has no workspace instead of offering an empty picker', async () => {
    rpc('workspaces.list').reply(200, { ok: true, data: { items: [], hasMore: false } })

    await expect(listForms(makeZ(), { authData })).rejects.toThrow(/no workspace/i)
  })
})

describe('listRequests (the request picker)', () => {
  const summary = (id, overrides = {}) => ({ id, status: 'pending', externalId: null, recipient: { email: null, name: null }, ...overrides })

  test('labels each request by recipient, status and external id, and keeps the cursor for the next page', async () => {
    workspace()
    rpc('requests.list', (params) => params.workspaceId === 'ws_1' && params.limit === 25 && params.cursor === undefined).reply(200, {
      ok: true,
      data: {
        items: [
          summary('req_1', { recipient: { email: 'ada@example.com', name: 'Ada' }, externalId: 'run-42' }),
          summary('req_2', { recipient: { email: null, name: 'Grace' }, status: 'completed' }),
          summary('req_3'),
        ],
        nextCursor: 'c2',
        hasMore: true,
      },
    })
    const z = makeZ()

    await expect(listRequests(z, { authData, inputData: {}, meta: { page: 0 } })).resolves.toEqual([
      { id: 'req_1', label: 'ada@example.com · pending · run-42' },
      { id: 'req_2', label: 'Grace · completed' },
      { id: 'req_3', label: 'No recipient · pending' },
    ])
    await expect(z.cursor.get()).resolves.toBe('c2')
  })

  test('the next page resumes from the stored cursor, within the form the action picked', async () => {
    rpc('requests.list', (params) => params.formId === 'form_1' && params.cursor === 'c2' && params.workspaceId === undefined).reply(200, {
      ok: true,
      data: { items: [summary('req_4')], nextCursor: null, hasMore: false },
    })
    const z = makeZ({ cursor: 'c2' })

    await expect(listRequests(z, { authData, inputData: { formId: 'form_1' }, meta: { page: 1 } })).resolves.toEqual([
      { id: 'req_4', label: 'No recipient · pending' },
    ])
    await expect(z.cursor.get()).resolves.toBe('')
  })

  test('a page after the last one is empty and calls nothing', async () => {
    await expect(listRequests(makeZ({ cursor: '' }), { authData, inputData: {}, meta: { page: 2 } })).resolves.toEqual([])
    expect(nock.pendingMocks()).toEqual([])
  })

  test('Request ID inputs offer the picker and an inline Find Request step', () => {
    expect(cancel.operation.inputFields[0]).toMatchObject({
      key: 'requestId',
      required: true,
      dynamic: 'request_list.id.label',
      search: 'find_request.id',
    })
  })
})
