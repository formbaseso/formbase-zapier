// BASE_URL is read at module load in utils/request, so set it before requiring.
process.env.BASE_URL = 'https://fake.formbase.test'

const nock = require('nock')
const hydrators = require('../hydrators')
const trigger = require('../triggers/public_link_submission_created')
const updatedTrigger = require('../triggers/public_link_submission_updated')
const abandonedTrigger = require('../triggers/public_link_submission_abandoned')
const { makeZ, makeSignedWebhookBundle } = require('./helpers')

const FAKE_BASE = process.env.BASE_URL
const authData = { access_token: 'fbo_access' }

function rpc(method, predicate = () => true) {
  return nock(FAKE_BASE).post('/api/v1', (body) => {
    if (body.method !== method) return false
    return predicate(body.params)
  })
}

const TRIGGERS = [
  { trigger, key: 'public_link_submission_created', label: 'Public Link Submission Created', eventType: 'submission_created', payloadType: 'submission.completed' },
  { trigger: updatedTrigger, key: 'public_link_submission_updated', label: 'Public Link Submission Updated', eventType: 'submission_updated', payloadType: 'submission.updated' },
  { trigger: abandonedTrigger, key: 'public_link_submission_abandoned', label: 'Public Link Submission Abandoned', eventType: 'submission_abandoned', payloadType: 'submission.abandoned' },
]

describe('public-link submission trigger definitions', () => {
  test.each(TRIGGERS)('$key is a REST hook trigger labelled $label whose sample is a $payloadType', ({ trigger, key, label, payloadType }) => {
    expect(trigger.key).toBe(key)
    expect(trigger.display.label).toBe(label)
    expect(trigger.operation.type).toBe('hook')
    expect(trigger.operation.cleanInputData).toBe(false)
    expect(trigger.operation.sample.type).toBe(payloadType)
    expect(typeof trigger.operation.outputFields[0]).toBe('function')
  })

  test('sample is the event envelope: answers once, display under the same keys, PDF outputs', () => {
    const { sample } = trigger.operation
    expect(sample.apiVersion).toBe('2026-09-24')
    expect(sample.data.submission.pdfUrl).toBeTruthy()
    expect(sample.data.submission.pdfFile).toBeTruthy()
    expect(sample).not.toHaveProperty('fields')
    expect(Array.isArray(sample.data.answers.attendees)).toBe(true)
    expect(Object.keys(sample.data.display)).toEqual(Object.keys(sample.data.answers))
    expect(sample.data.answers.book_a_call).toMatchObject({ status: 'confirmed', start: expect.any(String), timeZone: expect.any(String) })
    expect(sample.data.answers.pay_the_fee).toMatchObject({ status: 'paid', amount: 40, currency: 'USD' })
  })

  test.each(TRIGGERS)('$key picks its form from the hidden form_list trigger and has no Event field', ({ trigger }) => {
    const formField = trigger.operation.inputFields.find((field) => field.key === 'formId')
    expect(formField).toMatchObject({ required: true, dynamic: 'form_list.id.label' })
    expect(trigger.operation.inputFields.map((field) => field.key)).not.toContain('eventType')
  })

  test('only the abandoned trigger asks for an idle window, as a static required field', () => {
    expect(trigger.operation.inputFields.map((field) => field.key)).toEqual(['formId'])
    expect(updatedTrigger.operation.inputFields.map((field) => field.key)).toEqual(['formId'])

    const idleWindowField = abandonedTrigger.operation.inputFields.find((field) => field.key === 'idleWindow')
    expect(idleWindowField).toMatchObject({
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
          { key: 'book_a_call', type: 'schedule-appointment', title: 'Book a call', required: false, prefillable: false },
          { key: 'pay_the_fee', type: 'payment', title: 'Pay the fee', required: false, prefillable: false },
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
        { key: 'data__answers__book_a_call__start', label: 'Book a call › Start', type: 'datetime' },
        { key: 'data__answers__book_a_call__end', label: 'Book a call › End', type: 'datetime' },
        { key: 'data__answers__book_a_call__timeZone', label: 'Book a call › Time Zone', type: 'string' },
        { key: 'data__answers__book_a_call__meetingUrl', label: 'Book a call › Meeting URL', type: 'string' },
        { key: 'data__answers__book_a_call__status', label: 'Book a call › Status', type: 'string' },
        { key: 'data__answers__book_a_call__attendee__email', label: 'Book a call › Attendee Email', type: 'string' },
        { key: 'data__display__book_a_call', label: 'Book a call (display)', type: 'string' },
        { key: 'data__answers__pay_the_fee__status', label: 'Pay the fee › Status', type: 'string' },
        { key: 'data__answers__pay_the_fee__amount', label: 'Pay the fee › Amount', type: 'number' },
        { key: 'data__answers__pay_the_fee__currency', label: 'Pay the fee › Currency', type: 'string' },
        { key: 'data__answers__pay_the_fee__receiptUrl', label: 'Pay the fee › Receipt URL', type: 'string' },
        { key: 'data__answers__pay_the_fee__paidAt', label: 'Pay the fee › Paid At', type: 'datetime' },
        { key: 'data__display__pay_the_fee', label: 'Pay the fee (display)', type: 'string' },
      ])
    )
    expect(keys).not.toContain('data__answers__satisfaction')
    // An object answer is mapped per property, never as one opaque value.
    expect(keys).not.toContain('data__answers__book_a_call')
    expect(keys).not.toContain('data__answers__pay_the_fee')
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

  test('Public Link Submission Created registers submission_created with a signing secret and no idle window', async () => {
    let sent
    rpc('webhooks.create', (params) => {
      sent = params
      return true
    }).reply(200, { ok: true, data: { subscriptionId: 'int_1', formId: 'form_1', provider: 'zapier', targetUrl: 'https://hooks.zapier.com/abc', eventType: 'submission_created' } })

    const result = await trigger.operation.performSubscribe(makeZ(), {
      authData,
      targetUrl: 'https://hooks.zapier.com/abc',
      inputData: { formId: 'form_1', idleWindow: '3d' },
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

  test('Public Link Submission Updated registers submission_updated without an idle window', async () => {
    let sent
    rpc('webhooks.create', (params) => {
      sent = params
      return true
    }).reply(200, { ok: true, data: { subscriptionId: 'int_3', eventType: 'submission_updated' } })

    await updatedTrigger.operation.performSubscribe(makeZ(), {
      authData,
      targetUrl: 'https://hooks.zapier.com/updated',
      inputData: { formId: 'form_1', idleWindow: '3d' },
    })

    expect(sent).toEqual({
      formId: 'form_1',
      targetUrl: 'https://hooks.zapier.com/updated',
      provider: 'zapier',
      eventType: 'submission_updated',
      signingSecret: expect.stringMatching(/^whsec_[a-f0-9]{64}$/),
    })
  })

  test('Public Link Submission Abandoned registers submission_abandoned with its idle window', async () => {
    let sent
    rpc('webhooks.create', (params) => {
      sent = params
      return true
    }).reply(200, { ok: true, data: { subscriptionId: 'int_2', eventType: 'submission_abandoned', idleWindow: '3d' } })

    await abandonedTrigger.operation.performSubscribe(makeZ(), {
      authData,
      targetUrl: 'https://hooks.zapier.com/abandoned',
      inputData: { formId: 'form_1', idleWindow: '3d' },
    })

    expect(sent).toMatchObject({ eventType: 'submission_abandoned', idleWindow: '3d' })
  })

  test('performSubscribe surfaces the server validation message for a bad subscription', async () => {
    rpc('webhooks.create').reply(400, { ok: false, error: { code: 'VALIDATION_ERROR', message: 'idleWindow is required when eventType is "submission_abandoned"' } })

    await expect(
      abandonedTrigger.operation.performSubscribe(makeZ(), {
        authData,
        targetUrl: 'https://hooks.zapier.com/x',
        inputData: { formId: 'form_1' },
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

  test.each(TRIGGERS)('$key keeps a $payloadType delivery as delivered', async ({ trigger, payloadType }) => {
    const event = { ...completed(), type: payloadType }
    await expect(trigger.operation.perform(makeZ(), makeSignedWebhookBundle(event))).resolves.toEqual([event])
  })

  test('rejects a delivery of another event type instead of running the wrong Zap', async () => {
    const event = { ...completed(), type: 'submission.updated' }
    await expect(trigger.operation.perform(makeZ(), makeSignedWebhookBundle(event))).rejects.toThrow(
      'formbase delivered a submission.updated event to a submission.completed subscription.'
    )
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

  test.each(TRIGGERS)('$key relabels submissions.sample to the $payloadType it receives', async ({ trigger, payloadType }) => {
    const sample = { id: 'e_sample', type: 'submission.completed', test: true, data: { form: { id: 'form_1' }, submission: { id: 's1', pdfUrl: null }, answers: {}, display: {} } }
    rpc('submissions.sample', (params) => params.formId === 'form_1').reply(200, { ok: true, data: sample })

    const result = await trigger.operation.performList(makeZ(), { authData, inputData: { formId: 'form_1' } })
    expect(result).toEqual([{ ...sample, type: payloadType }])
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
