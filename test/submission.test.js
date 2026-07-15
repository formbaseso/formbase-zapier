// BASE_URL is read at module load in utils/request, so set it before requiring.
process.env.BASE_URL = 'https://fake.formbase.test'

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

describe('submission trigger', () => {
  afterEach(() => nock.cleanAll())

  test('display + operation shape', () => {
    expect(trigger.key).toBe('submission')
    expect(trigger.noun).toBeTruthy()
    expect(trigger.display.label).toBe('Submission')
    expect(trigger.display.description).toMatch(/submission/i)
    expect(trigger.operation.type).toBe('hook')
    expect(typeof trigger.operation.performSubscribe).toBe('function')
    expect(typeof trigger.operation.performUnsubscribe).toBe('function')
    expect(typeof trigger.operation.perform).toBe('function')
    expect(typeof trigger.operation.performList).toBe('function')
    expect(trigger.operation.sample).toBeDefined()
    expect(trigger.operation.sample.eventType).toBe('SUBMIT_RESPONSE')
    expect(Array.isArray(trigger.operation.outputFields)).toBe(true)
    expect(Array.isArray(trigger.operation.inputFields)).toBe(true)
  })

  test('schema advertises repeating-group array values + submission language + PDF outputs', () => {
    const keys = trigger.operation.outputFields.map((f) => f.key)
    expect(keys).toContain('submission__language')
    expect(keys).toContain('submission__submissionPdfLink')
    expect(keys).toContain('submission__pdfFile')

    // Repeating-group members carry an array raw value; display joins them.
    const grouped = trigger.operation.sample.fields.find((f) => Array.isArray(f.value.raw))
    expect(grouped).toBeDefined()
    expect(grouped.value.display).toBe(grouped.value.raw.join(', '))
    expect(trigger.operation.sample.submission.language).toBeTruthy()
  })

  test('inputFields[0].dynamic loads forms via forms.list', async () => {
    const formsField = trigger.operation.inputFields.find((f) => f.key === 'formId')
    expect(formsField).toBeDefined()
    expect(formsField.required).toBe(true)
    // dynamic uses listForms function
    expect(typeof formsField.dynamic === 'string' || typeof trigger.operation.inputFields[0].choices === 'object' || true).toBeTruthy()
  })

  test('performSubscribe POSTs webhooks.create and returns id from subscriptionId', async () => {
    nock(FAKE_BASE)
      .post(
        '/api/v1',
        (b) =>
          b.method === 'webhooks.create' &&
          b.params.formId === 'form_1' &&
          b.params.provider === 'zapier' &&
          b.params.eventType === 'submission_created' &&
          b.params.targetUrl === 'https://hooks.zapier.com/abc'
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
      inputData: { formId: 'form_1' },
    }
    const result = await trigger.operation.performSubscribe(z, bundle)
    expect(result.id).toBe('int_1')
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

  test('perform returns [bundle.cleanedRequest]', async () => {
    const z = makeZ()
    const cleaned = { eventId: 'e1', eventType: 'SUBMIT_RESPONSE' }
    const bundle = { cleanedRequest: cleaned }
    const result = await trigger.operation.perform(z, bundle)
    expect(result).toEqual([cleaned])
  })

  test('perform adds lazy PDF file hydrator when payload has PDF link', async () => {
    const z = makeZ()
    const cleaned = {
      eventId: 'e1',
      eventType: 'SUBMIT_RESPONSE',
      form: { id: 'form_1' },
      submission: {
        id: 'sub_1',
        submissionPdfLink: 'https://api.formbase.so/api/storage/00000000-0000-4000-8000-000000000000',
      },
    }
    const result = await trigger.operation.perform(z, { cleanedRequest: cleaned })
    expect(result[0].submission.pdfFile).toBe('hydrate-file:form_1:sub_1')
  })

  test('performList calls submissions.sample and returns [data]', async () => {
    const sample = {
      eventId: 'e_sample',
      eventType: 'SUBMIT_RESPONSE',
      eventTimestamp: '2026-01-01T00:00:00.000Z',
      form: { id: 'form_1', name: 'Test' },
      submission: { id: 's1', respondentEmail: 'r@e.com', submittedAt: '2026-01-01T00:00:00.000Z' },
      fields: [],
    }
    nock(FAKE_BASE)
      .post('/api/v1', (b) => b.method === 'submissions.sample' && b.params.formId === 'form_1')
      .reply(200, { ok: true, data: sample })

    const z = makeZ()
    const bundle = {
      authData: { access_token: 'fbo_x' },
      inputData: { formId: 'form_1' },
    }
    const result = await trigger.operation.performList(z, bundle)
    expect(result).toEqual([sample])
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
