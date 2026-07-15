'use strict'

const { formbaseRpc } = require('../utils/request')
const hydrators = require('../hydrators')
// listForms lives in utils/ rather than on this module so the Zapier schema
// validator does not flag it as an unknown trigger property.

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
  const data = await formbaseRpc({
    z,
    bundle,
    method: 'webhooks.create',
    params: {
      formId: bundle.inputData.formId,
      targetUrl: bundle.targetUrl,
      provider: 'zapier',
      eventType: 'submission_created',
    },
  })
  // webhooks.create returns { subscriptionId, formId, provider, targetUrl, eventType }.
  // Zapier stores the returned object as bundle.subscribeData for performUnsubscribe.
  return { id: data.subscriptionId }
}

async function performUnsubscribe(z, bundle) {
  const id = bundle.subscribeData?.id
  // webhooks.delete expects the param key `subscriptionId`.
  return formbaseRpc({ z, bundle, method: 'webhooks.delete', params: { subscriptionId: id } })
}

async function perform(z, bundle) {
  return [addPdfFileHydrator(z, bundle.cleanedRequest)]
}

async function performList(z, bundle) {
  const data = await formbaseRpc({
    z,
    bundle,
    method: 'submissions.sample',
    params: { formId: bundle.inputData.formId },
  })
  return [addPdfFileHydrator(z, data)]
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

const trigger = {
  key: 'submission',
  noun: 'Submission',
  display: {
    label: 'Submission',
    description: 'Triggers when a form receives a new or updated submission.',
  },
  operation: {
    type: 'hook',
    inputFields: [
      {
        key: 'formId',
        label: 'Form',
        type: 'string',
        required: true,
        dynamic: 'form_list.id.name',
        helpText: 'Choose which formbase form should fire this Zap.',
      },
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
