// BASE_URL is read at module load in utils/request, so set it before requiring.
process.env.BASE_URL = 'https://fake.formbase.test'

const nock = require('nock')
const cancel = require('../creates/cancel_request')
const remind = require('../creates/remind_request')
const get = require('../creates/get_request')
const find = require('../searches/find_request')
const { makeZ } = require('./helpers')

const FAKE_BASE = process.env.BASE_URL
const authData = { access_token: 'fbo_access' }
const summary = { id: 'req_1', status: 'pending', outcome: null, externalId: 'run-42', recipient: { email: 'ada@example.com', name: 'Ada' }, remindersSent: 0 }

function rpc(method, predicate = () => true) {
  return nock(FAKE_BASE).post('/api/v1', (body) => {
    if (body.method !== method) return false
    return predicate(body.params)
  })
}

afterEach(() => nock.cleanAll())

describe('cancel_request', () => {
  test('cancels by request id with the optional reason', async () => {
    rpc('requests.cancel', (params) => params.requestId === 'req_1' && params.reason === 'Order withdrawn').reply(200, { ok: true, data: { ...summary, status: 'canceled', cancelReason: 'Order withdrawn' } })

    await expect(cancel.operation.perform(makeZ(), { authData, inputData: { requestId: 'req_1', reason: 'Order withdrawn' } })).resolves.toMatchObject({ status: 'canceled' })
  })

  test('omits an empty reason and surfaces REQUEST_NOT_PENDING as a CONFLICT', async () => {
    rpc('requests.cancel', (params) => !('reason' in params)).reply(409, { ok: false, error: { code: 'CONFLICT', message: 'REQUEST_NOT_PENDING', details: { reason: 'REQUEST_NOT_PENDING' } } })

    await expect(cancel.operation.perform(makeZ(), { authData, inputData: { requestId: 'req_1', reason: '' } })).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})

describe('remind_request', () => {
  test('queues a reminder and returns the summary with remindersSent incremented', async () => {
    rpc('requests.remind', (params) => params.requestId === 'req_1').reply(200, { ok: true, data: { ...summary, remindersSent: 1 } })

    await expect(remind.operation.perform(makeZ(), { authData, inputData: { requestId: 'req_1' } })).resolves.toMatchObject({ remindersSent: 1 })
  })
})

describe('get_request', () => {
  const view = { ...summary, status: 'completed', outcome: 'approve', url: 'https://forms.formbase.test/r/rq_1', answers: { company_name: 'Acme' }, display: { company_name: 'Acme' }, timeline: [] }

  test('fetches the request with its answers and display', async () => {
    rpc('requests.get', (params) => params.requestId === 'req_1').reply(200, { ok: true, data: view })

    await expect(get.operation.perform(makeZ(), { authData, inputData: { requestId: 'req_1' } })).resolves.toEqual(view)
  })

  test('labels the answer outputs from the optional form, under answers__<key> / display__<key>', async () => {
    rpc('fields.list', (params) => params.formId === 'form_1').reply(200, {
      ok: true,
      data: { published: true, hasMore: false, items: [{ key: 'company_name', type: 'text', title: 'Company', required: true, prefillable: true }] },
    })

    const fields = await get.operation.outputFields[0](makeZ(), { authData, inputData: { requestId: 'req_1', formId: 'form_1' } })
    expect(fields).toEqual(
      expect.arrayContaining([
        { key: 'url', label: 'Request URL', type: 'string' },
        { key: 'outcome', label: 'Outcome', type: 'string' },
        { key: 'answers__company_name', label: 'Company' },
        { key: 'display__company_name', label: 'Company (display)', type: 'string' },
      ])
    )
  })

  test('lists the request outputs alone when no form is picked', async () => {
    const fields = await get.operation.outputFields[0](makeZ(), { authData, inputData: { requestId: 'req_1' } })
    expect(fields.map((field) => field.key)).toContain('status')
    expect(fields.some((field) => field.key.startsWith('answers__'))).toBe(false)
  })
})

describe('find_request', () => {
  test('is a search keyed find_request that lists requests by external id within a form', async () => {
    expect(find.key).toBe('find_request')
    rpc('requests.list', (params) => params.formId === 'form_1' && params.externalId === 'run-42' && params.workspaceId === undefined && params.includeTest === undefined).reply(200, {
      ok: true,
      data: { items: [summary], nextCursor: null, hasMore: false },
    })

    await expect(find.operation.perform(makeZ(), { authData, inputData: { externalId: 'run-42', formId: 'form_1' } })).resolves.toEqual([summary])
  })

  test('searches the whole workspace when no form is picked, and can include test requests', async () => {
    rpc('workspaces.list').reply(200, { ok: true, data: { items: [{ id: 'ws_1', name: 'Acme' }], hasMore: false } })
    rpc('requests.list', (params) => params.workspaceId === 'ws_1' && params.externalId === 'run-42' && params.includeTest === true).reply(200, {
      ok: true,
      data: { items: [], nextCursor: null, hasMore: false },
    })

    await expect(find.operation.perform(makeZ(), { authData, inputData: { externalId: 'run-42', includeTest: true } })).resolves.toEqual([])
  })
})
