'use strict'

const http = require('http')
const { signEvent } = require('./helpers')

const ACCESS_TOKEN = 'fbo_access'
const IDLE_WINDOWS = ['12h', '1d', '3d', '1w']

/**
 * An in-process formbase external API: enough of `POST /api/v1` for a connector
 * to run its whole lifecycle against real HTTP. It validates like the server
 * (bearer token, webhooks.create rules), stores subscriptions, and signs
 * deliveries with the secret each subscription registered.
 */
class FakeFormbase {
  constructor(options = {}) {
    this.workspace = options.workspace || { id: 'ws_1', name: 'Acme' }
    this.forms = options.forms || [{ id: 'form_1', name: 'Customer Feedback', published: true }]
    this.fields = options.fields || {}
    this.pdfUrl = options.pdfUrl || 'https://api.formbase.test/api/storage/pdf-key'
    this.subscriptions = new Map()
    this.calls = []
    this.nextSubscriptionId = 1
  }

  async start() {
    this.server = http.createServer((request, response) => this.handle(request, response))
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    this.baseUrl = `http://127.0.0.1:${this.server.address().port}`
    return this
  }

  async stop() {
    await new Promise((resolve) => this.server.close(resolve))
  }

  handle(request, response) {
    let content = ''
    request.on('data', (chunk) => (content += chunk))
    request.on('end', () => {
      const reply = (status, body) => {
        response.writeHead(status, { 'content-type': 'application/json' })
        response.end(JSON.stringify(body))
      }
      if (request.url !== '/api/v1' || request.method !== 'POST') return reply(404, { ok: false, error: { code: 'NOT_FOUND', message: 'No route' } })
      if (request.headers.authorization !== `Bearer ${ACCESS_TOKEN}`) {
        return reply(401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'Invalid token' } })
      }
      const { method, params = {} } = JSON.parse(content)
      this.calls.push({ method, params })
      const result = this.dispatch(method, params)
      if (result.error) return reply(result.status, { ok: false, error: result.error })
      return reply(200, { ok: true, data: result.data })
    })
  }

  dispatch(method, params) {
    switch (method) {
      case 'me.get':
        return { data: { id: 'u1', email: 'alice@example.com', name: 'Alice' } }
      case 'workspaces.list':
        return { data: { items: [this.workspace], hasMore: false } }
      case 'forms.list':
        return this.listForms(params)
      case 'fields.list':
        return this.listFields(params)
      case 'webhooks.create':
        return this.createWebhook(params)
      case 'webhooks.list':
        return { data: { items: [...this.subscriptions.values()].filter((s) => s.formId === params.formId), hasMore: false } }
      case 'webhooks.delete':
        if (!this.subscriptions.delete(params.subscriptionId)) return notFound('Webhook subscription not found')
        return { data: { subscriptionId: params.subscriptionId, deleted: true } }
      case 'submissions.sample':
        return { data: this.buildEvent({ formId: params.formId, type: 'submission.completed', test: true }) }
      case 'submissions.pdf':
        return { data: { url: this.pdfUrl, filename: `formbase-submission-${params.submissionId}.pdf`, contentType: 'application/pdf', byteLength: 123 } }
      default:
        return { status: 404, error: { code: 'METHOD_NOT_FOUND', message: `Unknown method: ${method}` } }
    }
  }

  listForms(params) {
    if (params.workspaceId !== this.workspace.id) return notFound('Workspace not found')
    const limit = params.limit || 100
    const start = params.cursor ? Number(params.cursor) : 0
    const items = this.forms.slice(start, start + limit).map((form) => ({ id: form.id, name: form.name, workspaceId: this.workspace.id }))
    const hasMore = start + limit < this.forms.length
    return { data: { items, hasMore, nextCursor: hasMore ? String(start + limit) : null } }
  }

  listFields(params) {
    const form = this.forms.find((candidate) => candidate.id === params.formId)
    if (!form) return notFound('Form not found')
    if (!form.published) return { data: { published: false, items: [], hasMore: false } }
    return { data: { published: true, items: this.fields[form.id] || [], hasMore: false } }
  }

  createWebhook(params) {
    const invalid = (message) => ({ status: 400, error: { code: 'VALIDATION_ERROR', message } })
    if (!this.forms.some((form) => form.id === params.formId)) return notFound('Form not found')
    if (!/^https:\/\//.test(params.targetUrl || '')) return invalid('targetUrl must be an https URL')
    if (!['zapier', 'make', 'n8n'].includes(params.provider)) return invalid('provider must be one of zapier, make, n8n')
    const eventType = params.eventType || 'submission_created'
    if (eventType !== 'submission_created' && eventType !== 'submission_abandoned') return invalid('eventType must be "submission_created" or "submission_abandoned"')
    if (eventType === 'submission_abandoned' && !IDLE_WINDOWS.includes(params.idleWindow)) return invalid('idleWindow is required when eventType is "submission_abandoned"')
    if (eventType === 'submission_created' && params.idleWindow !== undefined) return invalid('idleWindow is only valid when eventType is "submission_abandoned"')
    if (params.signingSecret !== undefined && (params.signingSecret.length < 32 || params.signingSecret.length > 255)) {
      return invalid('signingSecret must be between 32 and 255 characters')
    }
    const subscriptionId = `int_${this.nextSubscriptionId++}`
    const subscription = {
      subscriptionId,
      formId: params.formId,
      provider: params.provider,
      targetUrl: params.targetUrl,
      eventType,
      ...(params.idleWindow ? { idleWindow: params.idleWindow } : {}),
      status: 'active',
      createdAt: Date.now(),
    }
    this.subscriptions.set(subscriptionId, { ...subscription, signingSecret: params.signingSecret })
    return { data: subscription }
  }

  /** The event envelope for one form, with the sample answers the field list implies. */
  buildEvent({ formId, type = 'submission.completed', test = false, answers, display, pdfUrl = null, request }) {
    const form = this.forms.find((candidate) => candidate.id === formId)
    return {
      id: test ? 'evt_example000000000000' : `evt_${Math.random().toString(16).slice(2, 14)}`,
      type,
      createdAt: '2026-09-22T10:00:00.000Z',
      apiVersion: '2026-09-22',
      test,
      data: {
        form: { id: form.id, name: form.name, snapshotId: form.published ? `snap_${form.id}` : null },
        submission: {
          id: test ? 'sub_example000000000000' : 'sub_1',
          respondentEmail: 'respondent@example.com',
          submittedAt: '2026-09-22T10:00:00.000Z',
          pdfUrl,
          language: 'en',
        },
        answers: answers || {},
        display: display || {},
        ...(request ? { request } : {}),
      },
    }
  }

  /** What formbase POSTs to a subscription's target URL: the signed raw body and its headers. */
  deliver(subscriptionId, event, options = {}) {
    const subscription = this.subscriptions.get(subscriptionId)
    if (!subscription) throw new Error(`No subscription ${subscriptionId}`)
    const content = JSON.stringify(event)
    const timestamp = options.timestamp || Math.floor(Date.now() / 1000)
    return {
      headers: {
        'content-type': 'application/json',
        'x-formbase-event-id': event.id,
        'x-formbase-event-type': event.type,
        'x-formbase-signature': signEvent(subscription.signingSecret, timestamp, content),
      },
      content,
    }
  }
}

function notFound(message) {
  return { status: 404, error: { code: 'NOT_FOUND', message } }
}

module.exports = { FakeFormbase, ACCESS_TOKEN }
