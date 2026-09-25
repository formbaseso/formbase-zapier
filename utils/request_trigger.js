'use strict'

const { formbaseRpc } = require('./request')
const { createHookTrigger } = require('./hook_trigger')
const { EVENT_OUTPUT_FIELDS, SUBMISSION_OUTPUT_FIELDS, REQUEST_OUTPUT_FIELDS } = require('./events')
const { sampleEnvelope, sampleSubmission, sampleBookingAndPayment } = require('./samples')

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

function sampleFor(outcome, request, data = {}) {
  const { payloadType } = REQUEST_EVENTS[outcome]
  return sampleEnvelope(payloadType, { request: { ...SAMPLE_REQUEST, status: outcome, ...request }, ...data })
}

const { answers, display } = sampleBookingAndPayment({ name: 'Ada Lovelace', email: 'ada@example.com' })

// The sample a Zap editor sees before it tests the trigger: the same envelope
// `requests.sample` answers with, minus the form's own field keys. Only a
// completed request carries the submission, the answers and the display.
const SAMPLES = {
  completed: sampleFor(
    'completed',
    { outcome: 'approve', completedAt: '2026-04-26T12:34:56.000Z' },
    {
      form: { id: 'form_abc123', name: 'Vendor onboarding', snapshotId: 'snap_abc123' },
      submission: sampleSubmission('ada@example.com'),
      answers: { case_id: 'CASE-9', company_name: 'Acme', decision: 'approve', ...answers },
      display: { case_id: 'CASE-9', company_name: 'Acme', decision: 'Approve', ...display },
    }
  ),
  expired: sampleFor('expired', { expiredAt: '2026-05-26T12:00:00.000Z' }),
  canceled: sampleFor('canceled', { canceledAt: '2026-04-27T09:00:00.000Z', cancelReason: 'Order withdrawn' }),
}

/** The trigger for one request outcome, keyed by its subscription event type. */
function createRequestTrigger({ outcome, label, description, helpText }) {
  const { eventType, payloadType } = REQUEST_EVENTS[outcome]
  const isCompleted = outcome === 'completed'

  return createHookTrigger({
    key: eventType,
    noun: 'Request',
    label,
    description,
    formHelpText: helpText,
    eventType,
    payloadType,
    envelopeOutputFields: [...EVENT_OUTPUT_FIELDS, ...REQUEST_OUTPUT_FIELDS, ...(isCompleted ? SUBMISSION_OUTPUT_FIELDS : [])],
    carriesAnswers: isCompleted,
    sample: SAMPLES[outcome],
    performList: (z, bundle) =>
      formbaseRpc({ z, bundle, method: 'requests.sample', params: { formId: bundle.inputData.formId, eventType } }),
  })
}

module.exports = { createRequestTrigger, REQUEST_EVENTS }
