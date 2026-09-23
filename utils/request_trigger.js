'use strict'

const { formbaseRpc } = require('./request')
const { subscribe, unsubscribe, requireVerifiedDelivery } = require('./webhooks')
const { listFields, answerOutputFields } = require('./fields')
const { EVENT_OUTPUT_FIELDS, SUBMISSION_OUTPUT_FIELDS, REQUEST_OUTPUT_FIELDS, addPdfFileHydrator } = require('./events')

// A request event subscription (`webhooks.create` eventType) and the `type`
// of the one event it delivers (docs/external-api.md § Callbacks).
const REQUEST_EVENTS = {
  completed: { eventType: 'request_completed', payloadType: 'request.completed' },
  expired: { eventType: 'request_expired', payloadType: 'request.expired' },
  canceled: { eventType: 'request_canceled', payloadType: 'request.canceled' },
}

const SAMPLE_REQUEST = {
  id: 'req_example000000000000',
  externalId: 'run-42',
  language: 'en',
  recipient: { email: 'ada@example.com', name: 'Ada Lovelace' },
  metadata: { runId: 'run-42' },
  context: { case_id: 'CASE-9' },
  createdAt: '2026-04-26T12:00:00.000Z',
}

function sampleFor(status, extra) {
  return {
    id: 'evt_example000000000000',
    type: `request.${status}`,
    createdAt: '2026-04-26T12:34:56.000Z',
    apiVersion: '2026-09-22',
    test: false,
    data: { request: { ...SAMPLE_REQUEST, status, ...extra.request }, ...extra.data },
  }
}

// The sample a Zap editor sees before it tests the trigger: the same envelope
// `requests.sample` answers with, minus the form's own field keys.
const SAMPLES = {
  completed: sampleFor('completed', {
    request: { outcome: 'approve', completedAt: '2026-04-26T12:34:56.000Z' },
    data: {
      form: { id: 'form_abc123', name: 'Vendor onboarding', snapshotId: 'snap_abc123' },
      submission: {
        id: 'sub_xyz789',
        respondentEmail: 'ada@example.com',
        submittedAt: '2026-04-26T12:34:56.000Z',
        pdfUrl: 'https://api.formbase.so/api/storage/00000000-0000-4000-8000-000000000000',
        pdfFile: 'https://api.formbase.so/api/storage/00000000-0000-4000-8000-000000000000',
        language: 'en',
      },
      answers: { case_id: 'CASE-9', company_name: 'Acme', decision: 'approve' },
      display: { case_id: 'CASE-9', company_name: 'Acme', decision: 'Approve' },
    },
  }),
  expired: sampleFor('expired', { request: { expiredAt: '2026-05-26T12:00:00.000Z' } }),
  canceled: sampleFor('canceled', {
    request: { canceledAt: '2026-04-27T09:00:00.000Z', cancelReason: 'Order withdrawn' },
  }),
}

/**
 * A REST hook trigger for one request outcome. All three share the subscribe,
 * unsubscribe and signature code of the public-link submission triggers; only the event
 * type, the sample and (for a completed request) the answer outputs differ.
 */
function createRequestTrigger({ outcome, label, description, helpText }) {
  const { eventType, payloadType } = REQUEST_EVENTS[outcome]
  const isCompleted = outcome === 'completed'
  const envelopeOutputFields = [
    ...EVENT_OUTPUT_FIELDS,
    ...REQUEST_OUTPUT_FIELDS,
    ...(isCompleted ? SUBMISSION_OUTPUT_FIELDS : []),
  ]

  async function outputFields(z, bundle) {
    const formId = bundle.inputData.formId
    if (!isCompleted || !formId) return envelopeOutputFields

    const items = await listFields(z, bundle, formId)
    return [...envelopeOutputFields, ...items.flatMap((item) => answerOutputFields(item, 'data__'))]
  }

  async function performSubscribe(z, bundle) {
    return subscribe(z, bundle, { eventType })
  }

  /**
   * A subscription only ever receives its own event type, so anything else is
   * a payload this trigger does not understand. Rejecting it keeps a Zap that
   * waits for one outcome from running on another.
   */
  async function perform(z, bundle) {
    requireVerifiedDelivery(bundle)
    const event = bundle.cleanedRequest
    if (event.type !== payloadType) {
      throw new Error(`formbase delivered a ${event.type} event to a ${payloadType} subscription.`)
    }
    return [addPdfFileHydrator(z, event)]
  }

  async function performList(z, bundle) {
    const { formId } = bundle.inputData
    const sample = await formbaseRpc({ z, bundle, method: 'requests.sample', params: { formId, eventType } })
    return [addPdfFileHydrator(z, sample)]
  }

  return {
    key: eventType,
    noun: 'Request',
    display: { label, description },
    operation: {
      type: 'hook',
      cleanInputData: false,
      inputFields: [
        {
          key: 'formId',
          label: 'Form',
          type: 'string',
          required: true,
          dynamic: 'form_list.id.name',
          helpText,
        },
      ],
      performSubscribe,
      performUnsubscribe: unsubscribe,
      perform,
      performList,
      sample: SAMPLES[outcome],
      outputFields: [outputFields],
    },
  }
}

module.exports = { createRequestTrigger, REQUEST_EVENTS }
