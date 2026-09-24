'use strict'

const http = require('http')
const { signEvent } = require('./helpers')

const ACCESS_TOKEN = 'fbo_access'
const IDLE_WINDOWS = ['12h', '1d', '3d', '1w']
const SUBMISSION_EVENT_TYPES = ['submission_created', 'submission_updated', 'submission_abandoned']
const REQUEST_EVENT_TYPES = ['request_completed', 'request_expired', 'request_canceled']
const NOW = '2026-09-22T10:00:00.000Z'

/**
 * An in-process formbase external API: enough of `POST /api/v1` for a connector
 * to run its whole lifecycle against real HTTP. It validates like the server
 * (bearer token, webhooks.create rules, requests.create idempotency), stores
 * subscriptions and requests, and signs deliveries with the secret each
 * subscription registered.
 */
class FakeFormbase {
  constructor(options = {}) {
    this.workspace = options.workspace || { id: 'ws_1', name: 'Acme' }
    this.forms = options.forms || [{ id: 'form_1', name: 'Customer Feedback', published: true }]
    this.fields = options.fields || {}
    this.pdfUrl = options.pdfUrl || 'https://api.formbase.test/api/storage/pdf-key'
    this.subscriptions = new Map()
    this.requests = new Map()
    this.calls = []
    this.nextSubscriptionId = 1
    this.nextRequestId = 1
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
      case 'requests.create':
        return this.createRequest(params)
      case 'requests.get':
        return this.withRequest(params, (request) => ({ data: { ...request, url: request.url, answers: request.answers, display: request.display, timeline: [] } }))
      case 'requests.list':
        return this.listRequests(params)
      case 'requests.cancel':
        return this.withRequest(params, (request) => {
          if (request.status !== 'pending') return conflict('REQUEST_NOT_PENDING')
          Object.assign(request, { status: 'canceled', canceledAt: Date.parse(NOW), canceledBy: 'api', cancelReason: params.reason ?? null })
          return { data: summarize(request) }
        })
      case 'requests.remind':
        return this.withRequest(params, (request) => {
          if (request.status !== 'pending') return conflict('REQUEST_NOT_PENDING')
          if (!request.recipient.email) return { status: 400, error: { code: 'VALIDATION_ERROR', message: 'RECIPIENT_EMAIL_REQUIRED' } }
          request.remindersSent += 1
          return { data: summarize(request) }
        })
      case 'requests.sample':
        return this.sampleRequestEvent(params)
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
    if (![...SUBMISSION_EVENT_TYPES, ...REQUEST_EVENT_TYPES].includes(eventType)) return invalid(`eventType must be one of ${[...SUBMISSION_EVENT_TYPES, ...REQUEST_EVENT_TYPES].join(', ')}`)
    if (eventType === 'submission_abandoned' && !IDLE_WINDOWS.includes(params.idleWindow)) return invalid('idleWindow is required when eventType is "submission_abandoned"')
    if (eventType !== 'submission_abandoned' && params.idleWindow !== undefined) return invalid('idleWindow is only valid when eventType is "submission_abandoned"')
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

  /** `requests.create` with the server's idempotency rule: same key + same body → the original, `deduplicated: true`. */
  createRequest(params) {
    const form = this.forms.find((candidate) => candidate.id === params.formId)
    if (!form) return notFound('Form not found')
    if (!form.published) return { status: 400, error: { code: 'VALIDATION_ERROR', message: 'FORM_NOT_PUBLISHED' } }
    const body = JSON.stringify({ ...params, idempotencyKey: undefined })
    if (params.idempotencyKey) {
      const existing = [...this.requests.values()].find((request) => request.idempotencyKey === params.idempotencyKey)
      if (existing && existing.body !== body) return conflict('IDEMPOTENCY_CONFLICT')
      if (existing) return { data: { ...createResult(existing), deduplicated: true } }
    }
    const id = `req_${this.nextRequestId++}`
    const request = {
      id,
      workspaceId: this.workspace.id,
      formId: form.id,
      formSnapshotId: `snap_${form.id}`,
      submissionId: null,
      status: 'pending',
      outcome: null,
      createdVia: 'api',
      isTest: params.test === true,
      recipient: { email: params.recipient?.email ?? null, name: params.recipient?.name ?? null },
      language: params.language || 'en',
      externalId: params.externalId ?? null,
      metadata: params.metadata ?? null,
      context: params.context || {},
      prefill: params.prefill || {},
      readonlyKeys: params.readonly || [],
      documents: [],
      delivery: params.delivery || 'none',
      deliveryStatus: params.delivery === 'email' && params.test !== true ? 'queued' : 'not_requested',
      hasCallback: false,
      callbackFailedAt: null,
      expiresAt: params.expiresAt || Date.parse(NOW) + 30 * 24 * 3600 * 1000,
      createdAt: Date.parse(NOW),
      updatedAt: Date.parse(NOW),
      completedAt: null,
      expiredAt: null,
      canceledAt: null,
      canceledBy: null,
      cancelReason: null,
      remindersSent: 0,
      url: `https://forms.formbase.test/r/rq_${id}`,
      answers: null,
      display: null,
      idempotencyKey: params.idempotencyKey,
      body,
    }
    this.requests.set(id, request)
    return { data: { ...createResult(request), deduplicated: false } }
  }

  listRequests(params) {
    if (!params.formId && !params.workspaceId) return { status: 400, error: { code: 'VALIDATION_ERROR', message: 'SCOPE_REQUIRED' } }
    const items = [...this.requests.values()]
      .filter((request) => (params.formId ? request.formId === params.formId : request.workspaceId === params.workspaceId))
      .filter((request) => params.externalId === undefined || request.externalId === params.externalId)
      .filter((request) => params.includeTest === true || !request.isTest)
      .reverse()
      .map(summarize)
    return { data: { items, nextCursor: null, hasMore: false } }
  }

  withRequest(params, handler) {
    const request = this.requests.get(params.requestId)
    if (!request) return notFound('Request not found')
    return handler(request)
  }

  sampleRequestEvent(params) {
    if (!REQUEST_EVENT_TYPES.includes(params.eventType)) return { status: 400, error: { code: 'VALIDATION_ERROR', message: 'eventType must be a request event' } }
    const status = params.eventType.replace('request_', '')
    return { data: this.buildRequestEvent({ formId: params.formId, status, test: true }) }
  }

  /** The event envelope for one form, with the sample answers the field list implies. */
  buildEvent({ formId, type = 'submission.completed', test = false, answers, display, pdfUrl = null, request }) {
    const form = this.forms.find((candidate) => candidate.id === formId)
    return {
      id: test ? 'evt_example000000000000' : `evt_${Math.random().toString(16).slice(2, 14)}`,
      type,
      createdAt: NOW,
      apiVersion: '2026-09-24',
      test,
      data: {
        form: { id: form.id, name: form.name, snapshotId: form.published ? `snap_${form.id}` : null },
        submission: {
          id: test ? 'sub_example000000000000' : 'sub_1',
          respondentEmail: 'respondent@example.com',
          submittedAt: NOW,
          updatedAt: null,
          editCount: 0,
          pdfUrl,
          language: 'en',
        },
        answers: answers || {},
        display: display || {},
        ...(request ? { request } : {}),
      },
    }
  }

  /**
   * A request event: `data.request` always, plus the submission block, answers
   * and display on `completed` only (docs/external-api.md § Callbacks).
   */
  buildRequestEvent({ formId, status, test = false, request = {}, answers, display, pdfUrl = null }) {
    const requestBlock = {
      id: test ? 'req_example000000000000' : 'req_1',
      externalId: 'run-42',
      status,
      language: 'en',
      recipient: { email: 'ada@example.com', name: 'Ada' },
      metadata: { runId: 'run-42' },
      context: {},
      createdAt: NOW,
      ...(status === 'completed' ? { outcome: 'approve', completedAt: NOW } : {}),
      ...(status === 'expired' ? { expiredAt: NOW } : {}),
      ...(status === 'canceled' ? { canceledAt: NOW, cancelReason: 'Order withdrawn' } : {}),
      ...request,
    }
    const envelope = { id: test ? 'evt_example000000000000' : `evt_${Math.random().toString(16).slice(2, 14)}`, type: `request.${status}`, createdAt: NOW, apiVersion: '2026-09-24', test }
    if (status !== 'completed') return { ...envelope, data: { request: requestBlock } }
    const submissionEvent = this.buildEvent({ formId, test, answers, display, pdfUrl })
    return { ...envelope, data: { request: requestBlock, ...submissionEvent.data } }
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

function createResult(request) {
  const { id, status, url, deliveryStatus, expiresAt, createdAt, externalId } = request
  return { id, status, url, deliveryStatus, expiresAt, createdAt, externalId }
}

function summarize(request) {
  const { url, answers, display, idempotencyKey, body, ...summary } = request
  return summary
}

function notFound(message) {
  return { status: 404, error: { code: 'NOT_FOUND', message } }
}

function conflict(reason) {
  return { status: 409, error: { code: 'CONFLICT', message: reason, details: { reason } } }
}

module.exports = { FakeFormbase, ACCESS_TOKEN }
