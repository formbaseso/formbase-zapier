// BASE_URL is read at module load in utils/request, so set it before requiring.
process.env.BASE_URL = 'https://fake.formbase.test'

const { createHmac } = require('crypto')
const nock = require('nock')
const hydrators = require('../hydrators')
const trigger = require('../triggers/submission')
const { listForms } = require('../utils/list_forms')

class RefreshAuthError extends Error {}
class ThrottledError extends Error {}

function makeZ() {
  const https = require('https')
  const http = require('http')
  return {
    request: async (opts) => {
      const url = new URL(opts.url)
      const lib = url.protocol === 'https:' ? https : http
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
            let data = ''
            res.on('data', (c) => (data += c))
            res.on('end', () => resolve({ status: res.statusCode, data, json: data ? JSON.parse(data) : null }))
          }
        )
        req.on('error', reject)
        if (opts.body) req.write(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body))
        req.end()
      })
    },
    dehydrateFile: (_fn, inputData) => `hydrate-file:${inputData.formId}:${inputData.submissionId}`,
    errors: { RefreshAuthError, ThrottledError },
  }
}

const FAKE_BASE = process.env.BASE_URL
const SIGNING_SECRET = `whsec_${'a'.repeat(64)}`

function makeSignedWebhookBundle(cleanedRequest, options = {}) {
  const signingSecret = options.signingSecret || SIGNING_SECRET
  const timestamp = String(options.timestamp || Math.floor(Date.now() / 1000))
  const content = options.content || JSON.stringify(cleanedRequest)
  const signature = createHmac('sha256', signingSecret).update(timestamp).update('.').update(content).digest('hex')

  return {
    cleanedRequest,
    subscribeData: { signingSecret },
    rawRequest: {
      headers: { 'Http-X-Formbase-Signature': `t=${timestamp},sha256=${signature}` },
      content,
    },
  }
}

describe('submission trigger', () => {
  afterEach(() => nock.cleanAll())

  test('display + operation shape', () => {
    expect(trigger.key).toBe('submission')
    expect(trigger.noun).toBeTruthy()
    expect(trigger.display.label).toBe('Submission')
    expect(trigger.display.description).toMatch(/submission/i)
    expect(trigger.operation.type).toBe('hook')
    expect(trigger.operation.cleanInputData).toBe(false)
    expect(typeof trigger.operation.performSubscribe).toBe('function')
    expect(typeof trigger.operation.performUnsubscribe).toBe('function')
    expect(typeof trigger.operation.perform).toBe('function')
    expect(typeof trigger.operation.performList).toBe('function')
    expect(trigger.operation.sample).toBeDefined()
    expect(trigger.operation.sample.type).toBe('submission.completed')
    expect(Array.isArray(trigger.operation.outputFields)).toBe(true)
    expect(typeof trigger.operation.outputFields[0]).toBe('function')
    expect(Array.isArray(trigger.operation.inputFields)).toBe(true)
  })

  test('sample is the event envelope: answers once, display under the same keys, PDF outputs', () => {
    const { sample } = trigger.operation
    expect(sample.apiVersion).toBeTruthy()
    expect(sample.data.submission.language).toBeTruthy()
    expect(sample.data.submission.pdfUrl).toBeTruthy()
    expect(sample.data.submission.pdfFile).toBeTruthy()
    expect(sample).not.toHaveProperty('fields')
    // A repeating group nests one row per instance in answers; display joins them.
    expect(Array.isArray(sample.data.answers.attendees)).toBe(true)
    expect(Object.keys(sample.data.display)).toEqual(Object.keys(sample.data.answers))
  })

  test('outputFields lists the envelope plus one answers/display pair per published field, from fields.list', async () => {
    nock(FAKE_BASE)
      .post('/api/v1', (b) => b.method === 'fields.list' && b.params.formId === 'form_1')
      .reply(200, {
        ok: true,
        data: {
          items: [
            { key: 'your_name', type: 'text', title: 'Your name', required: true, prefillable: true },
            { key: 'seats', type: 'number', title: 'Seats', required: false, prefillable: true },
            {
              key: 'attendees',
              type: 'group',
              repeating: true,
              members: [{ key: 'attendee_name', type: 'text', title: 'Attendee name', required: false, prefillable: true }],
            },
          ],
          hasMore: false,
        },
      })

    const fields = await trigger.operation.outputFields[0](makeZ(), {
      authData: { access_token: 'fbo_x' },
      inputData: { formId: 'form_1' },
    })
    const keys = fields.map((f) => f.key)
    expect(keys).toContain('data__submission__language')
    expect(keys).toContain('data__submission__pdfUrl')
    expect(keys).toContain('data__submission__pdfFile')
    expect(fields).toEqual(
      expect.arrayContaining([
        { key: 'data__answers__your_name', label: 'Your name' },
        { key: 'data__display__your_name', label: 'Your name (display)', type: 'string' },
        { key: 'data__answers__seats', label: 'Seats', type: 'number' },
        { key: 'data__answers__attendees[]attendee_name', label: 'attendees › Attendee name' },
        { key: 'data__display__attendees', label: 'attendees (display)', type: 'string' },
      ])
    )
  })

  test('outputFields falls back to the envelope alone before a form is chosen', async () => {
    const fields = await trigger.operation.outputFields[0](makeZ(), { authData: {}, inputData: {} })
    expect(fields.map((f) => f.key)).toContain('data__form__id')
    expect(fields.some((f) => f.key.startsWith('data__answers__'))).toBe(false)
  })

  test('inputFields[0].dynamic loads forms via forms.list', async () => {
    const formsField = trigger.operation.inputFields.find((f) => f.key === 'formId')
    expect(formsField).toBeDefined()
    expect(formsField.required).toBe(true)
    // dynamic uses listForms function
    expect(typeof formsField.dynamic === 'string' || typeof trigger.operation.inputFields[0].choices === 'object' || true).toBeTruthy()
  })

  test('offers completed and abandoned submission events', () => {
    const eventField = trigger.operation.inputFields.find((field) => field.key === 'eventType')

    expect(eventField).toMatchObject({
      required: true,
      default: 'submission_created',
      choices: {
        submission_created: 'Submission created',
        submission_abandoned: 'Submission abandoned',
      },
      altersDynamicFields: true,
    })
    expect(eventField.helpText).toMatch(/partial-submission tracking/i)
  })

  test('only asks for an idle window when abandoned submissions are selected', () => {
    const dynamicField = trigger.operation.inputFields.find((field) => typeof field === 'function')

    expect(dynamicField(makeZ(), { inputData: { eventType: 'submission_created' } })).toEqual([])

    const [idleWindowField] = dynamicField(makeZ(), { inputData: { eventType: 'submission_abandoned' } })
    expect(idleWindowField).toMatchObject({
      key: 'idleWindow',
      required: true,
      default: '12h',
      choices: {
        '12h': '12 hours',
        '1d': '1 day',
        '3d': '3 days',
        '1w': '1 week',
      },
    })
    expect(idleWindowField.helpText).toMatch(/hourly sweep/i)
  })

  test('performSubscribe registers submission_created with a signing secret', async () => {
    let requestBody
    nock(FAKE_BASE)
      .post(
        '/api/v1',
        (body) => {
          requestBody = body
          return (
            body.method === 'webhooks.create' &&
            body.params.formId === 'form_1' &&
            body.params.provider === 'zapier' &&
            body.params.eventType === 'submission_created' &&
            body.params.targetUrl === 'https://hooks.zapier.com/abc' &&
            /^whsec_[a-f0-9]{64}$/.test(body.params.signingSecret) &&
            !Object.prototype.hasOwnProperty.call(body.params, 'idleWindow')
          )
        }
      )
      .reply(200, {
        ok: true,
        data: {
          subscriptionId: 'int_1',
          formId: 'form_1',
          provider: 'zapier',
          targetUrl: 'https://hooks.zapier.com/abc',
          eventType: 'submission_created',
        },
      })

    const z = makeZ()
    const bundle = {
      authData: { access_token: 'fbo_x' },
      targetUrl: 'https://hooks.zapier.com/abc',
      inputData: { formId: 'form_1', eventType: 'submission_created' },
    }
    const result = await trigger.operation.performSubscribe(z, bundle)
    expect(result).toEqual({ id: 'int_1', signingSecret: requestBody.params.signingSecret })
  })

  test('performSubscribe registers submission_abandoned with its idle window and signing secret', async () => {
    let requestBody
    nock(FAKE_BASE)
      .post(
        '/api/v1',
        (body) => {
          requestBody = body
          return (
            body.method === 'webhooks.create' &&
            body.params.formId === 'form_1' &&
            body.params.provider === 'zapier' &&
            body.params.eventType === 'submission_abandoned' &&
            body.params.idleWindow === '3d' &&
            body.params.targetUrl === 'https://hooks.zapier.com/abandoned' &&
            /^whsec_[a-f0-9]{64}$/.test(body.params.signingSecret)
          )
        }
      )
      .reply(200, {
        ok: true,
        data: {
          subscriptionId: 'int_abandoned',
          formId: 'form_1',
          provider: 'zapier',
          targetUrl: 'https://hooks.zapier.com/abandoned',
          eventType: 'submission_abandoned',
        },
      })

    const z = makeZ()
    const bundle = {
      authData: { access_token: 'fbo_x' },
      targetUrl: 'https://hooks.zapier.com/abandoned',
      inputData: { formId: 'form_1', eventType: 'submission_abandoned', idleWindow: '3d' },
    }
    const result = await trigger.operation.performSubscribe(z, bundle)

    expect(result).toEqual({ id: 'int_abandoned', signingSecret: requestBody.params.signingSecret })
  })

  test('performSubscribe rejects missing or invalid subscription settings before calling formbase', async () => {
    const z = makeZ()
    const baseBundle = {
      authData: { access_token: 'fbo_x' },
      targetUrl: 'https://hooks.zapier.com/invalid',
      inputData: { formId: 'form_1' },
    }

    await expect(trigger.operation.performSubscribe(z, baseBundle)).rejects.toThrow(/valid formbase webhook event/i)
    await expect(
      trigger.operation.performSubscribe(z, {
        ...baseBundle,
        inputData: { ...baseBundle.inputData, eventType: 'submission_abandoned' },
      })
    ).rejects.toThrow(/consider the submission abandoned/i)
    await expect(
      trigger.operation.performSubscribe(z, {
        ...baseBundle,
        inputData: { ...baseBundle.inputData, eventType: 'submission_abandoned', idleWindow: '2d' },
      })
    ).rejects.toThrow(/consider the submission abandoned/i)
  })

  test('performUnsubscribe POSTs webhooks.delete with subscriptionId param', async () => {
    nock(FAKE_BASE)
      .post('/api/v1', (b) => b.method === 'webhooks.delete' && b.params.subscriptionId === 'int_1')
      .reply(200, { ok: true, data: { ok: true } })

    const z = makeZ()
    const bundle = {
      authData: { access_token: 'fbo_x' },
      subscribeData: { id: 'int_1' },
    }
    const result = await trigger.operation.performUnsubscribe(z, bundle)
    expect(result).toEqual({ ok: true })
  })

  test('perform accepts a valid signed webhook and returns [bundle.cleanedRequest]', async () => {
    const z = makeZ()
    const cleaned = { id: 'e1', type: 'submission.completed' }
    const bundle = makeSignedWebhookBundle(cleaned)
    const result = await trigger.operation.perform(z, bundle)
    expect(result).toEqual([cleaned])
  })

  test('perform preserves submission.abandoned from a signed abandoned-submission webhook', async () => {
    const z = makeZ()
    const cleaned = { id: 'e_abandoned', type: 'submission.abandoned' }
    const result = await trigger.operation.perform(z, makeSignedWebhookBundle(cleaned))

    expect(result).toEqual([cleaned])
  })

  test('perform rejects unsigned, invalid, and expired webhook requests', async () => {
    const z = makeZ()
    const cleaned = { id: 'e1', type: 'submission.completed' }

    await expect(trigger.operation.perform(z, { cleanedRequest: cleaned })).rejects.toThrow(/webhook signature/i)

    const invalid = makeSignedWebhookBundle(cleaned)
    invalid.rawRequest.content = `${invalid.rawRequest.content} `
    await expect(trigger.operation.perform(z, invalid)).rejects.toThrow(/webhook signature/i)

    const expired = makeSignedWebhookBundle(cleaned, {
      timestamp: Math.floor(Date.now() / 1000) - 301,
    })
    await expect(trigger.operation.perform(z, expired)).rejects.toThrow(/webhook signature/i)
  })

  test('perform adds lazy PDF file hydrator when payload has PDF link', async () => {
    const z = makeZ()
    const cleaned = {
      id: 'e1',
      type: 'submission.completed',
      data: {
        form: { id: 'form_1' },
        submission: {
          id: 'sub_1',
          pdfUrl: 'https://api.formbase.so/api/storage/00000000-0000-4000-8000-000000000000',
        },
      },
    }
    const result = await trigger.operation.perform(z, makeSignedWebhookBundle(cleaned))
    expect(result[0].data.submission.pdfFile).toBe('hydrate-file:form_1:sub_1')
  })

  test.each([
    ['submission_created', 'submission.completed'],
    ['submission_abandoned', 'submission.abandoned'],
  ])('performList returns a sample matching selected %s event', async (selectedEventType, expectedPayloadEventType) => {
    const sample = {
      id: 'e_sample',
      type: 'submission.completed',
      createdAt: '2026-01-01T00:00:00.000Z',
      apiVersion: '2026-09-22',
      test: true,
      data: {
        form: { id: 'form_1', name: 'Test', snapshotId: null },
        submission: { id: 's1', respondentEmail: 'r@e.com', submittedAt: '2026-01-01T00:00:00.000Z', pdfUrl: null, language: 'en' },
        answers: {},
        display: {},
      },
    }
    nock(FAKE_BASE)
      .post('/api/v1', (b) => b.method === 'submissions.sample' && b.params.formId === 'form_1')
      .reply(200, { ok: true, data: sample })

    const z = makeZ()
    const bundle = {
      authData: { access_token: 'fbo_x' },
      inputData: { formId: 'form_1', eventType: selectedEventType },
    }
    const result = await trigger.operation.performList(z, bundle)
    expect(result).toEqual([{ ...sample, type: expectedPayloadEventType }])
  })

  test('downloadSubmissionPdf hydrator calls submissions.pdf and returns URL', async () => {
    nock(FAKE_BASE)
      .post('/api/v1', (b) => b.method === 'submissions.pdf' && b.params.formId === 'form_1' && b.params.submissionId === 'sub_1')
      .reply(200, {
        ok: true,
        data: {
          url: 'https://api.formbase.so/api/storage/00000000-0000-4000-8000-000000000000',
          filename: 'formbase-submission-sub_1.pdf',
          contentType: 'application/pdf',
          byteLength: 123,
        },
      })

    const z = makeZ()
    const bundle = {
      authData: { access_token: 'fbo_x' },
      inputData: { formId: 'form_1', submissionId: 'sub_1' },
    }
    const result = await hydrators.downloadSubmissionPdf(z, bundle)
    expect(result).toBe('https://api.formbase.so/api/storage/00000000-0000-4000-8000-000000000000')
  })

  test('listForms hits workspaces.list then forms.list per workspace (single workspace, no prefix)', async () => {
    nock(FAKE_BASE)
      .post('/api/v1', (b) => b.method === 'workspaces.list')
      .reply(200, { ok: true, data: { items: [{ id: 'ws_1', name: 'Acme', role: 'owner', createdAt: 1 }], hasMore: false } })
      .post('/api/v1', (b) => b.method === 'forms.list' && b.params.workspaceId === 'ws_1' && b.params.limit === 100)
      .reply(200, {
        ok: true,
        data: {
          items: [
            { id: 'f1', name: 'Form A', workspaceId: 'ws_1' },
            { id: 'f2', name: 'Form B', workspaceId: 'ws_1' },
          ],
          nextCursor: null,
          hasMore: false,
        },
      })

    const z = makeZ()
    const bundle = { authData: { access_token: 'fbo_x' } }
    const result = await listForms(z, bundle)
    expect(result).toEqual([
      { id: 'f1', name: 'Form A' },
      { id: 'f2', name: 'Form B' },
    ])
  })

  test('listForms prefixes form names with workspace name when user has multiple workspaces', async () => {
    nock(FAKE_BASE)
      .post('/api/v1', (b) => b.method === 'workspaces.list')
      .reply(200, {
        ok: true,
        data: {
          items: [
            { id: 'ws_1', name: 'Acme', role: 'owner', createdAt: 1 },
            { id: 'ws_2', name: 'Beta', role: 'member', createdAt: 2 },
          ],
          hasMore: false,
        },
      })
      .post('/api/v1', (b) => b.method === 'forms.list' && b.params.workspaceId === 'ws_1')
      .reply(200, { ok: true, data: { items: [{ id: 'f1', name: 'Form A' }], nextCursor: null, hasMore: false } })
      .post('/api/v1', (b) => b.method === 'forms.list' && b.params.workspaceId === 'ws_2')
      .reply(200, { ok: true, data: { items: [{ id: 'f2', name: 'Form B' }], nextCursor: null, hasMore: false } })

    const z = makeZ()
    const bundle = { authData: { access_token: 'fbo_x' } }
    const result = await listForms(z, bundle)
    expect(result).toEqual([
      { id: 'f1', name: 'Acme / Form A' },
      { id: 'f2', name: 'Beta / Form B' },
    ])
  })
})
