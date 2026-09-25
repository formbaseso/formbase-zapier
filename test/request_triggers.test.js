// BASE_URL is read at module load in utils/request, so set it before requiring.
process.env.BASE_URL = 'https://fake.formbase.test'

const nock = require('nock')
const requestCompleted = require('../triggers/request_completed')
const requestExpired = require('../triggers/request_expired')
const requestCanceled = require('../triggers/request_canceled')
const { makeZ, makeSignedWebhookBundle } = require('./helpers')

const FAKE_BASE = process.env.BASE_URL
const authData = { access_token: 'fbo_access' }

const TRIGGERS = [
  ['request_completed', 'request.completed', requestCompleted],
  ['request_expired', 'request.expired', requestExpired],
  ['request_canceled', 'request.canceled', requestCanceled],
]

function rpc(method, predicate = () => true) {
  return nock(FAKE_BASE).post('/api/v1', (body) => {
    if (body.method !== method) return false
    return predicate(body.params)
  })
}

function requestEvent(type, extra = {}) {
  return {
    id: 'e1',
    type,
    test: false,
    data: { request: { id: 'req_1', externalId: 'run-42', status: type.replace('request.', '') }, ...extra },
  }
}

describe('request trigger definitions', () => {
  test.each(TRIGGERS)('%s is a REST hook trigger whose sample is a %s event', (key, payloadType, trigger) => {
    expect(trigger.key).toBe(key)
    expect(trigger.noun).toBe('Request')
    expect(trigger.operation.type).toBe('hook')
    expect(trigger.operation.cleanInputData).toBe(false)
    expect(trigger.operation.sample.type).toBe(payloadType)
    expect(trigger.operation.sample.data.request.status).toBe(payloadType.replace('request.', ''))
    expect(trigger.operation.inputFields).toEqual([expect.objectContaining({ key: 'formId', required: true, dynamic: 'form_list.id.label' })])
  })

  test('only the completed sample carries the submission block and answers', () => {
    expect(requestCompleted.operation.sample.data).toMatchObject({ form: expect.any(Object), submission: expect.any(Object), answers: expect.any(Object), display: expect.any(Object) })
    expect(requestCompleted.operation.sample.data.request.outcome).toBe('approve')
    expect(Object.keys(requestExpired.operation.sample.data)).toEqual(['request'])
    expect(Object.keys(requestCanceled.operation.sample.data)).toEqual(['request'])
    expect(requestCanceled.operation.sample.data.request.cancelReason).toBeTruthy()
  })
})

describe('outputFields', () => {
  afterEach(() => nock.cleanAll())

  const FIELDS = [
    { key: 'company_name', type: 'text', title: 'Company', required: true, prefillable: true },
    { key: 'case_id', type: 'hidden', title: 'Case', required: false, prefillable: false, context: true },
  ]

  test('Request Completed lists the request block, the submission block and one answers/display pair per field', async () => {
    rpc('fields.list', (params) => params.formId === 'form_1').reply(200, { ok: true, data: { published: true, hasMore: false, items: FIELDS } })

    const fields = await requestCompleted.operation.outputFields[0](makeZ(), { authData, inputData: { formId: 'form_1' } })
    const keys = fields.map((field) => field.key)
    expect(keys).toEqual(
      expect.arrayContaining([
        'id',
        'type',
        'data__request__id',
        'data__request__externalId',
        'data__request__status',
        'data__request__outcome',
        'data__request__metadata',
        'data__request__recipient__email',
        'data__submission__id',
        'data__submission__pdfFile',
        'data__answers__company_name',
        'data__display__company_name',
        'data__answers__case_id',
      ])
    )
    expect(fields).toContainEqual({ key: 'data__answers__company_name', label: 'Company' })
  })

  test.each([
    ['request_expired', requestExpired],
    ['request_canceled', requestCanceled],
  ])('%s lists the request block only and never calls fields.list', async (_key, trigger) => {
    const fields = await trigger.operation.outputFields[0](makeZ(), { authData, inputData: { formId: 'form_1' } })
    const keys = fields.map((field) => field.key)
    expect(keys).toEqual(expect.arrayContaining(['data__request__id', 'data__request__status', 'data__request__cancelReason']))
    expect(keys.some((key) => key.startsWith('data__answers__') || key.startsWith('data__submission__'))).toBe(false)
    expect(nock.pendingMocks()).toEqual([])
  })
})

describe('subscribe / unsubscribe', () => {
  afterEach(() => nock.cleanAll())

  test.each(TRIGGERS)('%s subscribes with its event type, a signing secret and no idle window', async (key, _payloadType, trigger) => {
    let sent
    rpc('webhooks.create', (params) => {
      sent = params
      return true
    }).reply(200, { ok: true, data: { subscriptionId: 'int_9', formId: 'form_1', provider: 'zapier', targetUrl: 'https://hooks.zapier.com/abc', eventType: key } })

    const result = await trigger.operation.performSubscribe(makeZ(), {
      authData,
      targetUrl: 'https://hooks.zapier.com/abc',
      inputData: { formId: 'form_1' },
    })

    expect(sent).toEqual({
      formId: 'form_1',
      targetUrl: 'https://hooks.zapier.com/abc',
      provider: 'zapier',
      eventType: key,
      signingSecret: expect.stringMatching(/^whsec_[a-f0-9]{64}$/),
    })
    expect(result).toEqual({ id: 'int_9', signingSecret: sent.signingSecret })
  })

  test('performUnsubscribe deletes the subscription Zapier stored at subscribe time', async () => {
    rpc('webhooks.delete', (params) => params.subscriptionId === 'int_9').reply(200, { ok: true, data: { subscriptionId: 'int_9', deleted: true } })

    await expect(requestExpired.operation.performUnsubscribe(makeZ(), { authData, subscribeData: { id: 'int_9', signingSecret: 'x' } })).resolves.toEqual({ subscriptionId: 'int_9', deleted: true })
  })
})

describe('perform (a delivery)', () => {
  test.each(TRIGGERS)('%s accepts a signed %s event as the Zap item', async (_key, payloadType, trigger) => {
    const event = requestEvent(payloadType)
    await expect(trigger.operation.perform(makeZ(), makeSignedWebhookBundle(event))).resolves.toEqual([event])
  })

  test.each(TRIGGERS)('%s rejects an event of another type even when it is signed', async (_key, payloadType, trigger) => {
    const other = payloadType === 'request.expired' ? 'request.canceled' : 'request.expired'
    await expect(trigger.operation.perform(makeZ(), makeSignedWebhookBundle(requestEvent(other)))).rejects.toThrow(new RegExp(`${other} event to a ${payloadType} subscription`))
    await expect(trigger.operation.perform(makeZ(), makeSignedWebhookBundle(requestEvent('submission.completed')))).rejects.toThrow(/submission\.completed/)
  })

  test('rejects unsigned, tampered, and expired deliveries before looking at the type', async () => {
    const event = requestEvent('request.completed')

    await expect(requestCompleted.operation.perform(makeZ(), { cleanedRequest: event })).rejects.toThrow(/webhook signature/i)

    const tampered = makeSignedWebhookBundle(event)
    tampered.rawRequest.content = `${tampered.rawRequest.content} `
    await expect(requestCompleted.operation.perform(makeZ(), tampered)).rejects.toThrow(/webhook signature/i)

    const expired = makeSignedWebhookBundle(event, { timestamp: Math.floor(Date.now() / 1000) - 301 })
    await expect(requestCompleted.operation.perform(makeZ(), expired)).rejects.toThrow(/webhook signature/i)
  })

  test('a completed request with a PDF gets the lazy PDF File output like a submission', async () => {
    const event = requestEvent('request.completed', { form: { id: 'form_1' }, submission: { id: 'sub_1', pdfUrl: 'https://api.formbase.so/api/storage/x' }, answers: {}, display: {} })
    const [item] = await requestCompleted.operation.perform(makeZ(), makeSignedWebhookBundle(event))
    expect(item.data.submission.pdfFile).toBe('hydrate-file:form_1:sub_1')
    expect(item.data.request).toEqual(event.data.request)
  })
})

describe('performList (the sample Zapier tests with)', () => {
  afterEach(() => nock.cleanAll())

  test.each(TRIGGERS)('%s asks requests.sample for its own event type', async (key, payloadType, trigger) => {
    const sample = { id: 'evt_example000000000000', type: payloadType, test: true, data: { request: { id: 'req_example000000000000', status: payloadType.replace('request.', '') } } }
    rpc('requests.sample', (params) => params.formId === 'form_1' && params.eventType === key).reply(200, { ok: true, data: sample })

    await expect(trigger.operation.performList(makeZ(), { authData, inputData: { formId: 'form_1' } })).resolves.toEqual([sample])
  })
})
