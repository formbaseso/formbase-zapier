'use strict'

const { formbaseRpc } = require('../utils/request')
const { subscribe, unsubscribe, requireVerifiedDelivery } = require('../utils/webhooks')
const { listFields, answerOutputFields } = require('../utils/fields')
const { EVENT_OUTPUT_FIELDS, SUBMISSION_OUTPUT_FIELDS, addPdfFileHydrator } = require('../utils/events')
// listForms lives in utils/ rather than on this module so the Zapier schema
// validator does not flag it as an unknown trigger property.

// What a subscription watches (`webhooks.create` eventType) …
const WEBHOOK_EVENTS = {
  created: 'submission_created',
  abandoned: 'submission_abandoned',
}

const WEBHOOK_EVENT_CHOICES = {
  [WEBHOOK_EVENTS.created]: 'Submission created',
  [WEBHOOK_EVENTS.abandoned]: 'Submission abandoned',
}

// … and the `type` of the event each one delivers. A created subscription also
// receives `submission.updated` when a completed submission is edited.
const PAYLOAD_EVENT_TYPES = {
  [WEBHOOK_EVENTS.created]: 'submission.completed',
  [WEBHOOK_EVENTS.abandoned]: 'submission.abandoned',
}

const WEBHOOK_IDLE_WINDOW_CHOICES = {
  '12h': '12 hours',
  '1d': '1 day',
  '3d': '3 days',
  '1w': '1 week',
}

// The event envelope formbase sends (docs/external-api.md § Events): every
// answer once in `data.answers` (keyed by field key), its readable text under
// the same key in `data.display`. `pdfFile` is this trigger's own addition.
const SAMPLE = {
  id: 'evt_01HEXAMPLEEXAMPLE',
  type: 'submission.completed',
  createdAt: '2026-04-26T12:34:56.000Z',
  apiVersion: '2026-09-22',
  test: false,
  data: {
    form: { id: 'form_abc123', name: 'Customer Feedback', snapshotId: 'snap_abc123' },
    submission: {
      id: 'sub_xyz789',
      respondentEmail: 'respondent@example.com',
      submittedAt: '2026-04-26T12:34:56.000Z',
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
    },
    display: {
      your_name: 'Ada Lovelace',
      plan: 'Pro',
      how_likely_to_recommend: '9',
      attendees: 'Grace Hopper, Alan Turing',
    },
  },
}

// The envelope's own fields; the per-form answer fields are added by
// `outputFields` from fields.list, so a Zap editor sees real question titles.
const ENVELOPE_OUTPUT_FIELDS = [
  ...EVENT_OUTPUT_FIELDS,
  ...SUBMISSION_OUTPUT_FIELDS,
]

async function outputFields(z, bundle) {
  const formId = bundle.inputData.formId
  if (!formId) return ENVELOPE_OUTPUT_FIELDS

  const items = await listFields(z, bundle, formId)
  return [...ENVELOPE_OUTPUT_FIELDS, ...items.flatMap((item) => answerOutputFields(item, 'data__'))]
}

/**
 * Registers the REST hook. The input fields already constrain `eventType` and
 * `idleWindow` to valid choices and the server rejects anything else with a
 * readable VALIDATION_ERROR, so nothing is re-validated here.
 */
async function performSubscribe(z, bundle) {
  const { eventType, idleWindow } = bundle.inputData
  return subscribe(z, bundle, { eventType, ...(eventType === WEBHOOK_EVENTS.abandoned ? { idleWindow } : {}) })
}

async function perform(z, bundle) {
  requireVerifiedDelivery(bundle)
  return [addPdfFileHydrator(z, bundle.cleanedRequest)]
}

async function performList(z, bundle) {
  const { formId, eventType } = bundle.inputData
  const sample = await formbaseRpc({ z, bundle, method: 'submissions.sample', params: { formId } })
  // submissions.sample always describes a completed submission; relabel it so an
  // abandoned-submission Zap tests against the event type it will receive.
  return [addPdfFileHydrator(z, { ...sample, type: PAYLOAD_EVENT_TYPES[eventType] })]
}

function getIdleWindowInputFields(_z, bundle) {
  if (bundle.inputData.eventType !== WEBHOOK_EVENTS.abandoned) return []

  return [
    {
      key: 'idleWindow',
      label: 'Consider submission abandoned after',
      type: 'string',
      required: true,
      choices: WEBHOOK_IDLE_WINDOW_CHOICES,
      default: '12h',
      helpText:
        'Triggers after the response has no saved changes for this long. The hourly sweep can add up to one extra hour.',
    },
  ]
}

const trigger = {
  key: 'submission',
  noun: 'Submission',
  display: {
    label: 'Public Link Submission',
    description:
      'Triggers when someone submits the form through its public link, or abandons a submission there. A completed request fires Request Completed instead, never this trigger.',
  },
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
        helpText:
          'Choose which formbase form should fire this Zap. It fires for public-link submissions only; a completed request fires the Request Completed trigger instead, never this one.',
      },
      {
        key: 'eventType',
        label: 'Event',
        type: 'string',
        required: true,
        choices: WEBHOOK_EVENT_CHOICES,
        default: WEBHOOK_EVENTS.created,
        altersDynamicFields: true,
        helpText:
          'Submission created also fires when a completed submission is edited later (event type submission.updated). Abandoned submissions require partial-submission tracking on the formbase workspace.',
      },
      getIdleWindowInputFields,
    ],
    performSubscribe,
    performUnsubscribe: unsubscribe,
    perform,
    performList,
    sample: SAMPLE,
    outputFields: [outputFields],
  },
}

module.exports = trigger
