'use strict'

const { formbaseRpc } = require('./request')
const { createHookTrigger } = require('./hook_trigger')
const { EVENT_OUTPUT_FIELDS, SUBMISSION_OUTPUT_FIELDS } = require('./events')
const { sampleEnvelope, sampleSubmission, sampleBookingAndPayment } = require('./samples')

// A public-link submission subscription (`webhooks.create` eventType) and the
// `type` of the one event it delivers (docs/external-api.md § Events). An
// updated subscription receives `submission.updated` when a respondent edits a
// submission they already sent; a created subscription never does.
const SUBMISSION_EVENTS = {
  created: { eventType: 'submission_created', payloadType: 'submission.completed' },
  updated: { eventType: 'submission_updated', payloadType: 'submission.updated' },
  abandoned: { eventType: 'submission_abandoned', payloadType: 'submission.abandoned' },
}

// The abandoned trigger's own input: how long a draft sits untouched before
// formbase calls it abandoned. webhooks.create requires it for that event only,
// and rejects anything outside these choices with a readable VALIDATION_ERROR.
const IDLE_WINDOW_INPUT_FIELD = {
  key: 'idleWindow',
  label: 'Consider submission abandoned after',
  type: 'string',
  required: true,
  choices: { '12h': '12 hours', '1d': '1 day', '3d': '3 days', '1w': '1 week' },
  default: '12h',
  helpText: 'Fires after the submission has no saved changes for this long. The hourly sweep can add up to one hour.',
}

// The event envelope formbase sends: every answer once in `data.answers`
// (keyed by field key), its readable text under the same key in `data.display`.
function sampleFor(payloadType) {
  const bookingAndPayment = sampleBookingAndPayment({ name: 'Ada Lovelace', email: 'respondent@example.com' })
  return sampleEnvelope(payloadType, {
    form: { id: 'form_abc123', name: 'Customer Feedback', snapshotId: 'snap_abc123' },
    submission: sampleSubmission('respondent@example.com'),
    answers: {
      your_name: 'Ada Lovelace',
      plan: 'pro',
      how_likely_to_recommend: 9,
      // A repeating group: one row object per instance, keyed by member field key.
      attendees: [{ attendee_name: 'Grace Hopper' }, { attendee_name: 'Alan Turing' }],
      ...bookingAndPayment.answers,
    },
    display: {
      your_name: 'Ada Lovelace',
      plan: 'Pro',
      how_likely_to_recommend: '9',
      attendees: 'Grace Hopper, Alan Turing',
      ...bookingAndPayment.display,
    },
  })
}

/**
 * The trigger for one public-link submission event. A completed request fires
 * Request Completed, never one of these.
 */
function createPublicLinkSubmissionTrigger({ event, key, label, description }) {
  const { eventType, payloadType } = SUBMISSION_EVENTS[event]
  const isAbandoned = event === 'abandoned'

  return createHookTrigger({
    key,
    noun: 'Public Link Submission',
    label,
    description,
    formHelpText: 'The form to watch. Public-link submissions only; a completed request fires Request Completed instead.',
    eventType,
    payloadType,
    envelopeOutputFields: [...EVENT_OUTPUT_FIELDS, ...SUBMISSION_OUTPUT_FIELDS],
    carriesAnswers: true,
    extraInputFields: isAbandoned ? [IDLE_WINDOW_INPUT_FIELD] : [],
    subscribeParams: (bundle) => (isAbandoned ? { idleWindow: bundle.inputData.idleWindow } : {}),
    sample: sampleFor(payloadType),
    async performList(z, bundle) {
      const sample = await formbaseRpc({ z, bundle, method: 'submissions.sample', params: { formId: bundle.inputData.formId } })
      // submissions.sample always describes a completed submission; relabel it so an
      // updated or abandoned Zap tests against the event type it will receive.
      return { ...sample, type: payloadType }
    },
  })
}

module.exports = { createPublicLinkSubmissionTrigger, SUBMISSION_EVENTS }
