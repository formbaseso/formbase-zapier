'use strict'

const { formbaseRpc } = require('./request')
const { subscribe, unsubscribe, requireVerifiedDelivery } = require('./webhooks')
const { listFields, answerOutputFields } = require('./fields')
const { EVENT_OUTPUT_FIELDS, SUBMISSION_OUTPUT_FIELDS, addPdfFileHydrator } = require('./events')

// A public-link submission subscription (`webhooks.create` eventType) and the
// `type` of the one event it delivers (docs/external-api.md § Events). An
// updated subscription receives `submission.updated` when a respondent edits a
// submission they already sent; a created subscription never does.
const SUBMISSION_EVENTS = {
  created: { eventType: 'submission_created', payloadType: 'submission.completed' },
  updated: { eventType: 'submission_updated', payloadType: 'submission.updated' },
  abandoned: { eventType: 'submission_abandoned', payloadType: 'submission.abandoned' },
}

const IDLE_WINDOW_CHOICES = {
  '12h': '12 hours',
  '1d': '1 day',
  '3d': '3 days',
  '1w': '1 week',
}

// The abandoned trigger's own input: how long a draft sits untouched before
// formbase calls it abandoned. webhooks.create requires it for that event only.
const IDLE_WINDOW_INPUT_FIELD = {
  key: 'idleWindow',
  label: 'Consider submission abandoned after',
  type: 'string',
  required: true,
  choices: IDLE_WINDOW_CHOICES,
  default: '12h',
  helpText: 'Fires after the submission has no saved changes for this long. The hourly sweep can add up to one hour.',
}

// The event envelope formbase sends (docs/external-api.md § Events): every
// answer once in `data.answers` (keyed by field key), its readable text under
// the same key in `data.display`. `pdfFile` is this trigger's own addition.
function sampleFor(payloadType) {
  return {
    id: 'evt_01HEXAMPLEEXAMPLE',
    type: payloadType,
    createdAt: '2026-04-26T12:34:56.000Z',
    apiVersion: '2026-09-24',
    test: false,
    data: {
      form: { id: 'form_abc123', name: 'Customer Feedback', snapshotId: 'snap_abc123' },
      submission: {
        id: 'sub_xyz789',
        respondentEmail: 'respondent@example.com',
        submittedAt: '2026-04-26T12:34:56.000Z',
        // Null until the respondent edits the submission after submitting.
        updatedAt: null,
        editCount: 0,
        pdfUrl: 'https://api.formbase.so/api/storage/00000000-0000-4000-8000-000000000000',
        pdfFile: 'https://api.formbase.so/api/storage/00000000-0000-4000-8000-000000000000',
        // BCP-47 language the respondent submitted in (translated forms); null otherwise.
        language: 'en',
      },
      answers: {
        your_name: 'Ada Lovelace',
        plan: 'pro',
        how_likely_to_recommend: 9,
        // A repeating group: one row object per instance, keyed by member field key.
        attendees: [{ attendee_name: 'Grace Hopper' }, { attendee_name: 'Alan Turing' }],
        // A booking and a payment answer are objects; display keeps one line of text.
        book_a_call: {
          status: 'confirmed',
          start: '2026-04-29T07:00:00.000Z',
          end: '2026-04-29T07:30:00.000Z',
          timeZone: 'Europe/Oslo',
          attendee: { name: 'Ada Lovelace', email: 'respondent@example.com' },
          meetingUrl: 'https://app.cal.com/video/example',
          provider: 'cal.com',
          providerBookingId: 'booking_abc123',
          eventTitle: 'Intro call',
        },
        pay_the_fee: {
          status: 'paid',
          amount: 40,
          currency: 'USD',
          amountRefunded: 0,
          receiptUrl: 'https://pay.stripe.com/receipts/example',
          paidAt: '2026-04-26T12:30:00.000Z',
          refundedAt: null,
          disputedAt: null,
          provider: 'stripe',
          providerPaymentIntentId: 'pi_abc123',
        },
      },
      display: {
        your_name: 'Ada Lovelace',
        plan: 'Pro',
        how_likely_to_recommend: '9',
        attendees: 'Grace Hopper, Alan Turing',
        book_a_call: 'Intro call · Apr 29, 2026, 9:00 AM - 9:30 AM (Europe/Oslo) · Ada Lovelace <respondent@example.com> · https://app.cal.com/video/example',
        pay_the_fee: '$40.00 USD · Paid',
      },
    },
  }
}

// The envelope's own fields; the per-form answer fields are added by
// `outputFields` from fields.list, so a Zap editor sees real question titles.
const ENVELOPE_OUTPUT_FIELDS = [...EVENT_OUTPUT_FIELDS, ...SUBMISSION_OUTPUT_FIELDS]

async function outputFields(z, bundle) {
  const formId = bundle.inputData.formId
  if (!formId) return ENVELOPE_OUTPUT_FIELDS

  const items = await listFields(z, bundle, formId)
  return [...ENVELOPE_OUTPUT_FIELDS, ...items.flatMap((item) => answerOutputFields(item, 'data__'))]
}

/**
 * A REST hook trigger for one public-link submission event. All three share
 * the envelope, the output fields and the subscribe, unsubscribe and signature
 * code; only the event type, the labels and (for abandoned) the idle window
 * differ. A completed request fires Request Completed, never one of these.
 */
function createPublicLinkSubmissionTrigger({ event, key, label, description }) {
  const { eventType, payloadType } = SUBMISSION_EVENTS[event]
  const isAbandoned = event === 'abandoned'

  /**
   * The input fields constrain `idleWindow` to valid choices and the server
   * rejects anything else with a readable VALIDATION_ERROR, so nothing is
   * re-validated here.
   */
  async function performSubscribe(z, bundle) {
    if (!isAbandoned) return subscribe(z, bundle, { eventType })
    return subscribe(z, bundle, { eventType, idleWindow: bundle.inputData.idleWindow })
  }

  /**
   * A subscription only ever receives its own event type, so anything else is
   * a payload this trigger does not understand. Rejecting it keeps a Zap that
   * waits for one event from running on another.
   */
  async function perform(z, bundle) {
    requireVerifiedDelivery(bundle)
    const delivered = bundle.cleanedRequest
    if (delivered.type !== payloadType) {
      throw new Error(`formbase delivered a ${delivered.type} event to a ${payloadType} subscription.`)
    }
    return [addPdfFileHydrator(z, delivered)]
  }

  async function performList(z, bundle) {
    const { formId } = bundle.inputData
    const sample = await formbaseRpc({ z, bundle, method: 'submissions.sample', params: { formId } })
    // submissions.sample always describes a completed submission; relabel it so an
    // updated or abandoned Zap tests against the event type it will receive.
    return [addPdfFileHydrator(z, { ...sample, type: payloadType })]
  }

  return {
    key,
    noun: 'Public Link Submission',
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
          helpText: 'The form to watch. Public-link submissions only; a completed request fires Request Completed instead.',
        },
        ...(isAbandoned ? [IDLE_WINDOW_INPUT_FIELD] : []),
      ],
      performSubscribe,
      performUnsubscribe: unsubscribe,
      perform,
      performList,
      sample: sampleFor(payloadType),
      outputFields: [outputFields],
    },
  }
}

module.exports = { createPublicLinkSubmissionTrigger, SUBMISSION_EVENTS }
