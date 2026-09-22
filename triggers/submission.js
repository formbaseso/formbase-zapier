'use strict'

const { createHmac, randomBytes, timingSafeEqual } = require('crypto')
const { formbaseRpc } = require('../utils/request')
const hydrators = require('../hydrators')
// listForms lives in utils/ rather than on this module so the Zapier schema
// validator does not flag it as an unknown trigger property.

const WEBHOOK_EVENTS = {
  created: 'submission_created',
  abandoned: 'submission_abandoned',
}

const WEBHOOK_EVENT_CHOICES = {
  [WEBHOOK_EVENTS.created]: 'Submission created',
  [WEBHOOK_EVENTS.abandoned]: 'Submission abandoned',
}

// The `type` of the event formbase POSTs for each subscription.
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

const SIGNATURE_HEADER_PATTERN = /^t=(\d+),sha256=([a-f0-9]{64})$/
const SIGNATURE_MAX_AGE_SECONDS = 5 * 60

// The event envelope formbase sends (docs/external-api.md § Events): every
// answer once in `data.answers` (keyed by field key), its readable text under
// the same key in `data.display`.
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
      how_likely_to_recommend: 9,
      // A repeating group: one row object per instance, keyed by member field key.
      attendees: [{ attendee_name: 'Grace Hopper' }, { attendee_name: 'Alan Turing' }],
    },
    display: {
      your_name: 'Ada Lovelace',
      how_likely_to_recommend: '9',
      attendees: 'Grace Hopper, Alan Turing',
    },
  },
}

// The envelope's own fields; the per-form answer fields are added by
// `outputFields` from fields.list, so a Zap editor sees real question titles.
const ENVELOPE_OUTPUT_FIELDS = [
  { key: 'id', label: 'Event ID', type: 'string' },
  { key: 'type', label: 'Event Type', type: 'string' },
  { key: 'createdAt', label: 'Event Timestamp', type: 'datetime' },
  { key: 'test', label: 'Test Event', type: 'boolean' },
  { key: 'data__form__id', label: 'Form ID', type: 'string' },
  { key: 'data__form__name', label: 'Form Name', type: 'string' },
  { key: 'data__submission__id', label: 'Submission ID', type: 'string' },
  { key: 'data__submission__respondentEmail', label: 'Respondent Email', type: 'string' },
  { key: 'data__submission__submittedAt', label: 'Submitted At', type: 'datetime' },
  { key: 'data__submission__pdfUrl', label: 'PDF Link', type: 'string' },
  { key: 'data__submission__pdfFile', label: 'PDF File', type: 'file' },
  { key: 'data__submission__language', label: 'Submission Language', type: 'string' },
]

const ZAPIER_TYPE_BY_FIELD_TYPE = {
  number: 'number',
  rating: 'number',
  scale: 'number',
  switch: 'boolean',
  date: 'datetime',
}

/**
 * One Zapier output field per answer, from the form's published field list:
 * `data__answers__<key>` carries the stored value, `data__display__<key>` the
 * readable text. A repeating group's members are line items under the group key.
 */
async function outputFields(z, bundle) {
  const formId = bundle.inputData.formId
  if (!formId) return ENVELOPE_OUTPUT_FIELDS

  const data = await listPublishedFields(z, bundle, formId)
  if (!data) return ENVELOPE_OUTPUT_FIELDS
  const fields = []
  for (const item of data?.items ?? []) {
    if (Array.isArray(item.members)) {
      // A group entry carries no title of its own; its key is what the caller addresses it by.
      for (const member of item.members) {
        fields.push({ key: `data__answers__${item.key}[]${member.key}`, label: `${item.key} › ${member.title}` })
      }
      fields.push({ key: `data__display__${item.key}`, label: `${item.key} (display)`, type: 'string' })
      continue
    }
    fields.push({
      key: `data__answers__${item.key}`,
      label: item.title,
      ...(ZAPIER_TYPE_BY_FIELD_TYPE[item.type] ? { type: ZAPIER_TYPE_BY_FIELD_TYPE[item.type] } : {}),
    })
    fields.push({ key: `data__display__${item.key}`, label: `${item.title} (display)`, type: 'string' })
  }
  return [...ENVELOPE_OUTPUT_FIELDS, ...fields]
}

/**
 * The form's published field list, or null when the form has none to list yet —
 * `fields.list` rejects an unpublished form with VALIDATION_ERROR, and a Zap may
 * legitimately be wired up before the form is published. Output fields are
 * advisory, so that case falls back to the envelope; every other failure
 * (auth, rate limit, transport) still surfaces.
 */
async function listPublishedFields(z, bundle, formId) {
  try {
    return await formbaseRpc({ z, bundle, method: 'fields.list', params: { formId } })
  } catch (error) {
    if (error?.code === 'VALIDATION_ERROR' || error?.code === 'NOT_FOUND') return null
    throw error
  }
}

async function performSubscribe(z, bundle) {
  const eventType = bundle.inputData.eventType
  if (!Object.prototype.hasOwnProperty.call(WEBHOOK_EVENT_CHOICES, eventType)) {
    throw new Error('Select a valid formbase webhook event.')
  }

  const idleWindow = bundle.inputData.idleWindow
  if (
    eventType === WEBHOOK_EVENTS.abandoned &&
    !Object.prototype.hasOwnProperty.call(WEBHOOK_IDLE_WINDOW_CHOICES, idleWindow)
  ) {
    throw new Error('Select when formbase should consider the submission abandoned.')
  }

  const signingSecret = createWebhookSigningSecret()
  const data = await formbaseRpc({
    z,
    bundle,
    method: 'webhooks.create',
    params: {
      formId: bundle.inputData.formId,
      targetUrl: bundle.targetUrl,
      provider: 'zapier',
      eventType,
      ...(eventType === WEBHOOK_EVENTS.abandoned ? { idleWindow } : {}),
      signingSecret,
    },
  })
  // webhooks.create never returns the secret. Zapier stores this object as
  // bundle.subscribeData, which is available when webhook requests arrive.
  return { id: data.subscriptionId, signingSecret }
}

async function performUnsubscribe(z, bundle) {
  const id = bundle.subscribeData?.id
  // webhooks.delete expects the param key `subscriptionId`.
  return formbaseRpc({ z, bundle, method: 'webhooks.delete', params: { subscriptionId: id } })
}

async function perform(z, bundle) {
  if (!verifyWebhookSignature(bundle)) {
    throw new Error('Invalid or expired formbase webhook signature.')
  }
  return [addPdfFileHydrator(z, bundle.cleanedRequest)]
}

async function performList(z, bundle) {
  const data = await formbaseRpc({
    z,
    bundle,
    method: 'submissions.sample',
    params: { formId: bundle.inputData.formId },
  })
  return [addPdfFileHydrator(z, withSelectedPayloadEventType(data, bundle.inputData.eventType))]
}

function withSelectedPayloadEventType(payload, webhookEventType) {
  const type = PAYLOAD_EVENT_TYPES[webhookEventType]
  if (!type || payload?.type === type) return payload
  return { ...payload, type }
}

function addPdfFileHydrator(z, payload) {
  // `pdfUrl: null` is the event saying no PDF is kept for this submission, so
  // the PDF File output is legitimately absent.
  const pdfUrl = payload?.data?.submission?.pdfUrl
  if (!pdfUrl) return payload

  // A PDF with nothing to hydrate it from is a payload we no longer understand.
  // Fail loudly: silently dropping the output is how the PDF File mapping
  // disappeared from live Zaps the last time the envelope changed.
  const formId = payload?.data?.form?.id
  const submissionId = payload?.data?.submission?.id
  if (!formId || !submissionId) {
    throw new Error('formbase event carries a submission PDF but no data.form.id / data.submission.id to hydrate it from.')
  }
  return {
    ...payload,
    data: {
      ...payload.data,
      submission: {
        ...payload.data.submission,
        pdfFile: z.dehydrateFile(hydrators.downloadSubmissionPdf, { formId, submissionId }),
      },
    },
  }
}

function createWebhookSigningSecret() {
  return `whsec_${randomBytes(32).toString('hex')}`
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

function verifyWebhookSignature(bundle) {
  const secret = bundle.subscribeData?.signingSecret
  if (typeof secret !== 'string' || secret.length === 0) return false

  const headers = bundle.rawRequest?.headers
  if (!headers || typeof headers !== 'object') return false

  const signatureHeader = Object.entries(headers).find(([name]) => {
    const normalizedName = name.toLowerCase()
    return normalizedName === 'http-x-formbase-signature' || normalizedName === 'x-formbase-signature'
  })?.[1]
  if (typeof signatureHeader !== 'string') return false

  const match = SIGNATURE_HEADER_PATTERN.exec(signatureHeader)
  if (!match) return false

  const [, timestamp, signatureHex] = match
  const timestampSeconds = Number(timestamp)
  if (!Number.isSafeInteger(timestampSeconds)) return false

  const currentTimestampSeconds = Math.floor(Date.now() / 1000)
  if (Math.abs(currentTimestampSeconds - timestampSeconds) > SIGNATURE_MAX_AGE_SECONDS) return false

  const rawBody = bundle.rawRequest?.content
  if (typeof rawBody !== 'string' && !Buffer.isBuffer(rawBody)) return false

  const expectedSignature = createHmac('sha256', secret).update(timestamp).update('.').update(rawBody).digest()
  const receivedSignature = Buffer.from(signatureHex, 'hex')

  return expectedSignature.length === receivedSignature.length && timingSafeEqual(expectedSignature, receivedSignature)
}

const trigger = {
  key: 'submission',
  noun: 'Submission',
  display: {
    label: 'Submission',
    description: 'Triggers when a form receives a completed or abandoned submission.',
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
        helpText: 'Choose which formbase form should fire this Zap.',
      },
      {
        key: 'eventType',
        label: 'Event',
        type: 'string',
        required: true,
        choices: WEBHOOK_EVENT_CHOICES,
        default: WEBHOOK_EVENTS.created,
        altersDynamicFields: true,
        helpText: 'Abandoned submissions require partial-submission tracking on the formbase workspace.',
      },
      getIdleWindowInputFields,
    ],
    performSubscribe,
    performUnsubscribe,
    perform,
    performList,
    sample: SAMPLE,
    outputFields: [outputFields],
  },
}

module.exports = trigger
