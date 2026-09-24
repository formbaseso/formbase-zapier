'use strict'

const hydrators = require('../hydrators')

// The envelope's own fields, shared by every event formbase sends
// (docs/external-api.md § Events).
const EVENT_OUTPUT_FIELDS = [
  { key: 'id', label: 'Event ID', type: 'string' },
  { key: 'type', label: 'Event Type', type: 'string' },
  { key: 'createdAt', label: 'Event Timestamp', type: 'datetime' },
  { key: 'test', label: 'Test Event', type: 'boolean' },
]

// `data.form` and `data.submission`: present on every submission event and on
// `request.completed`. `pdfFile` is this app's own addition, see addPdfFileHydrator.
const SUBMISSION_OUTPUT_FIELDS = [
  { key: 'data__form__id', label: 'Form ID', type: 'string' },
  { key: 'data__form__name', label: 'Form Name', type: 'string' },
  { key: 'data__submission__id', label: 'Submission ID', type: 'string' },
  { key: 'data__submission__respondentEmail', label: 'Respondent Email', type: 'string' },
  { key: 'data__submission__submittedAt', label: 'Submitted At', type: 'datetime' },
  { key: 'data__submission__updatedAt', label: 'Last Edited At', type: 'datetime' },
  { key: 'data__submission__editCount', label: 'Edit Count', type: 'integer' },
  { key: 'data__submission__pdfUrl', label: 'PDF Link', type: 'string' },
  { key: 'data__submission__pdfFile', label: 'PDF File', type: 'file' },
  { key: 'data__submission__language', label: 'Submission Language', type: 'string' },
]

// `data.request` as a request event carries it (docs/external-api.md § Callbacks).
const REQUEST_OUTPUT_FIELDS = [
  { key: 'data__request__id', label: 'Request ID', type: 'string' },
  { key: 'data__request__externalId', label: 'Request External ID', type: 'string' },
  { key: 'data__request__status', label: 'Request Status', type: 'string' },
  { key: 'data__request__outcome', label: 'Outcome', type: 'string' },
  { key: 'data__request__language', label: 'Request Language', type: 'string' },
  { key: 'data__request__recipient__email', label: 'Recipient Email', type: 'string' },
  { key: 'data__request__recipient__name', label: 'Recipient Name', type: 'string' },
  { key: 'data__request__metadata', label: 'Metadata', dict: true },
  { key: 'data__request__context', label: 'Context', dict: true },
  { key: 'data__request__createdAt', label: 'Request Created At', type: 'datetime' },
  { key: 'data__request__completedAt', label: 'Completed At', type: 'datetime' },
  { key: 'data__request__expiredAt', label: 'Expired At', type: 'datetime' },
  { key: 'data__request__canceledAt', label: 'Canceled At', type: 'datetime' },
  { key: 'data__request__cancelReason', label: 'Cancel Reason', type: 'string' },
]

/**
 * Adds the lazy PDF File output to an event that carries a submission PDF.
 *
 * `pdfUrl: null` is the event saying no PDF is kept for this submission, so
 * the PDF File output is legitimately absent. A PDF with nothing to hydrate it
 * from is a payload we no longer understand: fail loudly, because silently
 * dropping the output is how the PDF File mapping disappeared from live Zaps
 * the last time the envelope changed.
 */
function addPdfFileHydrator(z, payload) {
  const pdfUrl = payload.data?.submission?.pdfUrl
  if (!pdfUrl) return payload

  const formId = payload.data.form?.id
  const submissionId = payload.data.submission.id
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

module.exports = { EVENT_OUTPUT_FIELDS, SUBMISSION_OUTPUT_FIELDS, REQUEST_OUTPUT_FIELDS, addPdfFileHydrator }
