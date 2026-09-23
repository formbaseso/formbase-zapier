// BASE_URL is read at module load in utils/request, so set it before requiring.
process.env.BASE_URL = 'https://fake.formbase.test'

const nock = require('nock')
const hydrators = require('../hydrators')
const trigger = require('../triggers/public_link_submission')
const { listForms } = require('../utils/list_forms')
const { makeZ, makeSignedWebhookBundle } = require('./helpers')

const FAKE_BASE = process.env.BASE_URL
const authData = { access_token: 'fbo_access' }

function rpc(method, predicate = () => true) {
  return nock(FAKE_BASE).post('/api/v1', (body) => {
    if (body.method !== method) return false
    return predicate(body.params)
  })
}

describe('submission trigger definition', () => {
  test('is a REST hook trigger keyed `public_link_submission`, the key that matches its label', () => {
    expect(trigger.key).toBe('public_link_submission')
    expect(trigger.operation.type).toBe('hook')
    expect(trigger.operation.cleanInputData).toBe(false)
    expect(trigger.operation.sample.type).toBe('submission.completed')
    expect(typeof trigger.operation.outputFields[0]).toBe('function')
  })

  test('sample is the event envelope: answers once, display under the same keys, PDF outputs', () => {
    const { sample } = trigger.operation
    expect(sample.apiVersion).toBe('2026-09-22')
    expect(sample.data.submission.pdfUrl).toBeTruthy()
    expect(sample.data.submission.pdfFile).toBeTruthy()
    expect(sample).not.toHaveProperty('fields')
    expect(Array.isArray(sample.data.answers.attendees)).toBe(true)
    expect(Object.keys(sample.data.display)).toEqual(Object.keys(sample.data.answers))
  })

  test('the form picker is a dynamic dropdown fed by the hidden form_list trigger', () => {
    const formField = trigger.operation.inputFields.find((field) => field.key === 'formId')
    expect(formField).toMatchObject({ required: true, dynamic: 'form_list.id.name' })
  })

  test('offers completed and abandoned submission events, created by default', () => {
    const eventField = trigger.operation.inputFields.find((field) => field.key === 'eventType')
    expect(eventField).toMatchObject({
      required: true,
      default: 'submission_created',
      choices: { submission_created: 'Submission created', submission_abandoned: 'Submission abandoned' },
      altersDynamicFields: true,
    })
    expect(eventField.helpText).toMatch(/submission\.updated/)
  })

  test('only asks for an idle window when abandoned submissions are selected', () => {
    const dynamicField = trigger.operation.inputFields.find((field) => typeof field === 'function')

    expect(dynamicField(makeZ(), { inputData: { eventType: 'submission_created' } })).toEqual([])

    const [idleWindowField] = dynamicField(makeZ(), { inputData: { eventType: 'submission_abandoned' } })
    expect(idleWindowField).toMatchObject({
      key: 'idleWindow',
      required: true,
      default: '12h',
      choices: { '12h': '12 hours', '1d': '1 day', '3d': '3 days', '1w': '1 week' },
    })
  })
})

describe('outputFields', () => {
  afterEach(() => nock.cleanAll())

  const outputFields = (inputData) => trigger.operation.outputFields[0](makeZ(), { authData, inputData })

  test('lists the envelope plus one answers/display pair per published field, from fields.list', async () => {
    rpc('fields.list', (params) => params.formId === 'form_1').reply(200, {
      ok: true,
      data: {
        published: true,
        hasMore: false,
        items: [
          { key: 'your_name', type: 'text', title: 'Your name', required: true, prefillable: true },
          { key: 'seats', type: 'number', title: 'Seats', required: false, prefillable: true },
          { key: 'plan', type: 'select', title: 'Plan', required: false, prefillable: true, options: [{ key: 'pro', label: 'Pro' }] },
          {
            key: 'satisfaction',
            type: 'matrix',
            title: 'How did we do?',
            required: false,
            prefillable: true,
            rows: [{ key: 'delivery_speed', label: 'Delivery speed' }, { key: 'support', label: 'Support' }],
            columns: [{ key: 'very_good', label: 'Very good' }, { key: 'poor', label: 'Poor' }],
          },
          {
            key: 'attendees',
            type: 'group',
            repeating: true,
            members: [{ key: 'attendee_name', type: 'text', title: 'Attendee name', required: false, prefillable: true }],
          },
        ],
      },
    })

    const fields = await outputFields({ formId: 'form_1' })
    const keys = fields.map((field) => field.key)
    expect(keys).toEqual(expect.arrayContaining(['data__submission__pdfFile']))
    expect(keys).not.toContain('data__request__id')
    expect(fields).toEqual(
      expect.arrayContaining([
        { key: 'data__answers__your_name', label: 'Your name' },
        { key: 'data__display__your_name', label: 'Your name (display)', type: 'string' },
        { key: 'data__answers__seats', label: 'Seats', type: 'number' },
        { key: 'data__answers__plan', label: 'Plan' },
        { key: 'data__display__plan', label: 'Plan (display)', type: 'string' },
        { key: 'data__answers__satisfaction__delivery_speed', label: 'How did we do? › Delivery speed', type: 'string' },
        { key: 'data__answers__satisfaction__support', label: 'How did we do? › Support', type: 'string' },
        { key: 'data__display__satisfaction', label: 'How did we do? (display)', type: 'string' },
        { key: 'data__answers__attendees[]attendee_name', label: 'attendees › Attendee name' },
        { key: 'data__display__attendees', label: 'attendees (display)', type: 'string' },
      ])
    )
    expect(keys).not.toContain('data__answers__satisfaction')
  })

  test('falls back to the envelope alone before a form is chosen', async () => {
    const fields = await outputFields({})
    expect(fields.map((field) => field.key)).toContain('data__form__id')
    expect(fields.some((field) => field.key.startsWith('data__answers__'))).toBe(false)
  })

  test('lists the envelope alone for a form that is not published yet', async () => {
    rpc('fields.list').reply(200, { ok: true, data: { published: false, items: [], hasMore: false } })

    const fields = await outputFields({ formId: 'form_draft' })
    expect(fields.map((field) => field.key)).toContain('data__form__id')
    expect(fields.some((field) => field.key.startsWith('data__answers__'))).toBe(false)
  })

  test('surfaces a formbase failure instead of hiding the answer fields', async () => {
    rpc('fields.list').reply(404, { ok: false, error: { code: 'NOT_FOUND', message: 'Form not found' } })

    await expect(outputFields({ formId: 'form_gone' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('subscribe / unsubscribe', () => {
  afterEach(() => nock.cleanAll())

  test('performSubscribe registers submission_created with a signing secret and no idle window', async () => {
    let sent
    rpc('webhooks.create', (params) => {
      sent = params
      return true
    }).reply(200, { ok: true, data: { subscriptionId: 'int_1', formId: 'form_1', provider: 'zapier', targetUrl: 'https://hooks.zapier.com/abc', eventType: 'submission_created' } })

    const result = await trigger.operation.performSubscribe(makeZ(), {
      authData,
      targetUrl: 'https://hooks.zapier.com/abc',
      inputData: { formId: 'form_1', eventType: 'submission_created', idleWindow: '3d' },
    })

    expect(sent).toEqual({
      formId: 'form_1',
      targetUrl: 'https://hooks.zapier.com/abc',
      provider: 'zapier',
      eventType: 'submission_created',
      signingSecret: expect.stringMatching(/^whsec_[a-f0-9]{64}$/),
    })
    expect(result).toEqual({ id: 'int_1', signingSecret: sent.signingSecret })
  })

  test('performSubscribe registers submission_abandoned with its idle window', async () => {
    let sent
    rpc('webhooks.create', (params) => {
      sent = params
      return true
    }).reply(200, { ok: true, data: { subscriptionId: 'int_2', eventType: 'submission_abandoned', idleWindow: '3d' } })

    await trigger.operation.performSubscribe(makeZ(), {
      authData,
      targetUrl: 'https://hooks.zapier.com/abandoned',
      inputData: { formId: 'form_1', eventType: 'submission_abandoned', idleWindow: '3d' },
    })

    expect(sent).toMatchObject({ eventType: 'submission_abandoned', idleWindow: '3d' })
  })

  test('performSubscribe surfaces the server validation message for a bad subscription', async () => {
    rpc('webhooks.create').reply(400, { ok: false, error: { code: 'VALIDATION_ERROR', message: 'idleWindow is required when eventType is "submission_abandoned"' } })

    await expect(
      trigger.operation.performSubscribe(makeZ(), {
        authData,
        targetUrl: 'https://hooks.zapier.com/x',
        inputData: { formId: 'form_1', eventType: 'submission_abandoned' },
      })
    ).rejects.toThrow(/idleWindow is required/)
  })

  test('performUnsubscribe deletes the subscription Zapier stored at subscribe time', async () => {
    rpc('webhooks.delete', (params) => params.subscriptionId === 'int_1').reply(200, { ok: true, data: { subscriptionId: 'int_1', deleted: true } })

    const result = await trigger.operation.performUnsubscribe(makeZ(), { authData, subscribeData: { id: 'int_1', signingSecret: 'x' } })
    expect(result).toEqual({ subscriptionId: 'int_1', deleted: true })
  })
})

describe('perform (a delivery)', () => {
  const completed = (submission = {}) => ({
    id: 'e1',
    type: 'submission.completed',
    data: { form: { id: 'form_1' }, submission: { id: 'sub_1', pdfUrl: null, ...submission } },
  })

  test('accepts a valid signed webhook and returns the event as the Zap item', async () => {
    const event = completed()
    await expect(trigger.operation.perform(makeZ(), makeSignedWebhookBundle(event))).resolves.toEqual([event])
  })

  test('keeps submission.abandoned and submission.updated as delivered', async () => {
    for (const type of ['submission.abandoned', 'submission.updated']) {
      const event = { ...completed(), type }
      await expect(trigger.operation.perform(makeZ(), makeSignedWebhookBundle(event))).resolves.toEqual([event])
    }
  })

  test('rejects unsigned, tampered, and expired webhook requests', async () => {
    const event = completed()

    await expect(trigger.operation.perform(makeZ(), { cleanedRequest: event })).rejects.toThrow(/webhook signature/i)

    const tampered = makeSignedWebhookBundle(event)
    tampered.rawRequest.content = `${tampered.rawRequest.content} `
    await expect(trigger.operation.perform(makeZ(), tampered)).rejects.toThrow(/webhook signature/i)

    const expired = makeSignedWebhookBundle(event, { timestamp: Math.floor(Date.now() / 1000) - 301 })
    await expect(trigger.operation.perform(makeZ(), expired)).rejects.toThrow(/webhook signature/i)
  })

  test('adds the lazy PDF File hydrator when the event carries a PDF link', async () => {
    const event = completed({ pdfUrl: 'https://api.formbase.so/api/storage/x' })
    const [item] = await trigger.operation.perform(makeZ(), makeSignedWebhookBundle(event))
    expect(item.data.submission.pdfFile).toBe('hydrate-file:form_1:sub_1')
  })

  test('leaves the PDF File output absent when the event keeps no PDF', async () => {
    const [item] = await trigger.operation.perform(makeZ(), makeSignedWebhookBundle(completed()))
    expect(item.data.submission).not.toHaveProperty('pdfFile')
  })

  test('fails loudly when a PDF event carries no ids to hydrate from', async () => {
    const event = { id: 'e1', type: 'submission.completed', data: { form: {}, submission: { pdfUrl: 'https://api.formbase.so/api/storage/x' } } }
    await expect(trigger.operation.perform(makeZ(), makeSignedWebhookBundle(event))).rejects.toThrow(/hydrate it from/i)
  })
})

describe('performList (the sample Zapier tests with)', () => {
  afterEach(() => nock.cleanAll())

  test.each([
    ['submission_created', 'submission.completed'],
    ['submission_abandoned', 'submission.abandoned'],
  ])('relabels submissions.sample to the event type a %s subscription receives', async (eventType, expectedType) => {
    const sample = { id: 'e_sample', type: 'submission.completed', test: true, data: { form: { id: 'form_1' }, submission: { id: 's1', pdfUrl: null }, answers: {}, display: {} } }
    rpc('submissions.sample', (params) => params.formId === 'form_1').reply(200, { ok: true, data: sample })

    const result = await trigger.operation.performList(makeZ(), { authData, inputData: { formId: 'form_1', eventType } })
    expect(result).toEqual([{ ...sample, type: expectedType }])
  })
})

describe('downloadSubmissionPdf hydrator', () => {
  afterEach(() => nock.cleanAll())

  test('calls submissions.pdf and returns the proxy URL', async () => {
    rpc('submissions.pdf', (params) => params.formId === 'form_1' && params.submissionId === 'sub_1').reply(200, {
      ok: true,
      data: { url: 'https://api.formbase.so/api/storage/pdf', filename: 'formbase-submission-sub_1.pdf', contentType: 'application/pdf', byteLength: 123 },
    })

    const result = await hydrators.downloadSubmissionPdf(makeZ(), { authData, inputData: { formId: 'form_1', submissionId: 'sub_1' } })
    expect(result).toBe('https://api.formbase.so/api/storage/pdf')
  })
})

describe('listForms (the form picker)', () => {
  afterEach(() => nock.cleanAll())

  test('lists every form of the token workspace, following the cursor across pages', async () => {
    rpc('workspaces.list').reply(200, { ok: true, data: { items: [{ id: 'ws_1', name: 'Acme', role: 'owner' }], hasMore: false } })
    rpc('forms.list', (params) => params.workspaceId === 'ws_1' && params.limit === 100 && params.cursor === undefined).reply(200, {
      ok: true,
      data: { items: [{ id: 'f1', name: 'Form A', workspaceId: 'ws_1' }], nextCursor: 'c2', hasMore: true },
    })
    rpc('forms.list', (params) => params.cursor === 'c2').reply(200, {
      ok: true,
      data: { items: [{ id: 'f2', name: 'Form B', workspaceId: 'ws_1' }], nextCursor: null, hasMore: false },
    })

    await expect(listForms(makeZ(), { authData })).resolves.toEqual([
      { id: 'f1', name: 'Form A' },
      { id: 'f2', name: 'Form B' },
    ])
  })

  test('fails when the connection has no workspace instead of offering an empty picker', async () => {
    rpc('workspaces.list').reply(200, { ok: true, data: { items: [], hasMore: false } })

    await expect(listForms(makeZ(), { authData })).rejects.toThrow(/no workspace/i)
  })
})
