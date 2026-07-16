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

const PAYLOAD_EVENT_TYPES = {
  [WEBHOOK_EVENTS.created]: 'SUBMIT_RESPONSE',
  [WEBHOOK_EVENTS.abandoned]: 'ABANDON_RESPONSE',
}

const WEBHOOK_IDLE_WINDOW_CHOICES = {
  '12h': '12 hours',
  '1d': '1 day',
  '3d': '3 days',
  '1w': '1 week',
}

const SIGNATURE_HEADER_PATTERN = /^t=(\d+),sha256=([a-f0-9]{64})$/
const SIGNATURE_MAX_AGE_SECONDS = 5 * 60

const SAMPLE = {
  eventId: 'evt_01HEXAMPLEEXAMPLE',
  eventType: 'SUBMIT_RESPONSE',
  eventTimestamp: '2026-04-26T12:34:56.000Z',
  form: { id: 'form_abc123', name: 'Customer Feedback' },
  submission: {
    id: 'sub_xyz789',
    respondentEmail: 'respondent@example.com',
    submittedAt: '2026-04-26T12:34:56.000Z',
    submissionPdfLink: 'https://api.formbase.so/api/storage/00000000-0000-4000-8000-000000000000',
    pdfFile: 'https://api.formbase.so/api/storage/00000000-0000-4000-8000-000000000000',
    // BCP-47 language the respondent submitted in (translated forms); null otherwise.
    language: 'en',
  },
  fields: [
    {
      fieldId: 'fld_name',
      title: 'Your name',
      type: 'short_text',
      value: { raw: 'Ada Lovelace', display: 'Ada Lovelace' },
    },
    {
      fieldId: 'fld_rating',
      title: 'How likely to recommend?',
      type: 'rating',
      value: { raw: 9, display: '9' },
    },
    {
      // Repeating-group member: `raw` is the array of every per-row value in
      // live order; `display` joins them with ", ".
      fieldId: 'fld_attendee',
      title: 'Attendee name',
      type: 'short_text',
      value: { raw: ['Grace Hopper', 'Alan Turing'], display: 'Grace Hopper, Alan Turing' },
    },
  ],
}

// Static output fields derived from the sample (v1 — no dynamic schema fetch).
const OUTPUT_FIELDS = [
  { key: 'eventId', label: 'Event ID', type: 'string' },
  { key: 'eventType', label: 'Event Type', type: 'string' },
  { key: 'eventTimestamp', label: 'Event Timestamp', type: 'datetime' },
  { key: 'form__id', label: 'Form ID', type: 'string' },
  { key: 'form__name', label: 'Form Name', type: 'string' },
  { key: 'submission__id', label: 'Submission ID', type: 'string' },
  { key: 'submission__respondentEmail', label: 'Respondent Email', type: 'string' },
  { key: 'submission__submittedAt', label: 'Submitted At', type: 'datetime' },
  { key: 'submission__submissionPdfLink', label: 'PDF Link', type: 'string' },
  { key: 'submission__pdfFile', label: 'PDF File', type: 'file' },
  { key: 'submission__language', label: 'Submission Language', type: 'string' },
  { key: 'fields[]fieldId', label: 'Field ID', type: 'string' },
  { key: 'fields[]title', label: 'Field Title', type: 'string' },
  { key: 'fields[]type', label: 'Field Type', type: 'string' },
  // raw is an array for repeating-group members (one entry per row), scalar otherwise.
  { key: 'fields[]value__raw', label: 'Field Value (raw)' },
  { key: 'fields[]value__display', label: 'Field Value (display)', type: 'string' },
]

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
  const eventType = PAYLOAD_EVENT_TYPES[webhookEventType]
  if (!eventType || payload?.eventType === eventType) return payload
  return { ...payload, eventType }
}

function addPdfFileHydrator(z, payload) {
  const formId = payload?.form?.id
  const submissionId = payload?.submission?.id
  const pdfLink = payload?.submission?.submissionPdfLink
  if (!formId || !submissionId || !pdfLink) return payload
  return {
    ...payload,
    submission: {
      ...payload.submission,
      pdfFile: z.dehydrateFile(hydrators.downloadSubmissionPdf, { formId, submissionId }),
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
    outputFields: OUTPUT_FIELDS,
  },
}

module.exports = trigger
