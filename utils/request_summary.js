'use strict'

// A request summary as `requests.list`, `requests.cancel` and `requests.remind`
// return it (docs/external-api.md § Requests): no answers, no timeline.
const REQUEST_SUMMARY_OUTPUT_FIELDS = [
  { key: 'id', label: 'Request ID', type: 'string' },
  { key: 'status', label: 'Status', type: 'string' },
  { key: 'outcome', label: 'Outcome', type: 'string' },
  { key: 'formId', label: 'Form ID', type: 'string' },
  { key: 'submissionId', label: 'Submission ID', type: 'string' },
  { key: 'isTest', label: 'Test Request', type: 'boolean' },
  { key: 'recipient__email', label: 'Recipient Email', type: 'string' },
  { key: 'recipient__name', label: 'Recipient Name', type: 'string' },
  { key: 'language', label: 'Language', type: 'string' },
  { key: 'externalId', label: 'External ID', type: 'string' },
  { key: 'metadata', label: 'Metadata', dict: true },
  { key: 'context', label: 'Context', dict: true },
  { key: 'delivery', label: 'Delivery', type: 'string' },
  { key: 'deliveryStatus', label: 'Delivery Status', type: 'string' },
  { key: 'expiresAt', label: 'Expires At', type: 'datetime' },
  { key: 'createdAt', label: 'Created At', type: 'datetime' },
  { key: 'completedAt', label: 'Completed At', type: 'datetime' },
  { key: 'expiredAt', label: 'Expired At', type: 'datetime' },
  { key: 'canceledAt', label: 'Canceled At', type: 'datetime' },
  { key: 'cancelReason', label: 'Cancel Reason', type: 'string' },
  { key: 'remindersSent', label: 'Reminders Sent', type: 'integer' },
]

const SAMPLE_REQUEST_SUMMARY = {
  id: 'req_example000000000000',
  workspaceId: 'ws_abc123',
  formId: 'form_abc123',
  formSnapshotId: 'snap_abc123',
  submissionId: null,
  status: 'pending',
  outcome: null,
  createdVia: 'api',
  isTest: false,
  recipient: { email: 'ada@example.com', name: 'Ada Lovelace' },
  language: 'en',
  externalId: 'run-42',
  metadata: { runId: 'run-42' },
  context: { case_id: 'CASE-9' },
  prefill: { company_name: 'Acme' },
  readonlyKeys: ['company_name'],
  documents: [],
  delivery: 'email',
  deliveryStatus: 'sent',
  hasCallback: false,
  callbackFailedAt: null,
  expiresAt: '2026-06-25T12:00:00.000Z',
  createdAt: '2026-05-26T12:00:00.000Z',
  updatedAt: '2026-05-26T12:00:00.000Z',
  openedAt: null,
  startedAt: null,
  lastActivityAt: null,
  completedAt: null,
  expiredAt: null,
  canceledAt: null,
  canceledBy: null,
  cancelReason: null,
  reminderStep: 0,
  remindersSent: 0,
  reminderDueAt: null,
  dataPurgedAt: null,
}

// Pick a recent request from the dropdown while building the Zap, map the id
// from an earlier step, or add a Find Request step inline (`search`).
const REQUEST_ID_INPUT_FIELD = {
  key: 'requestId',
  label: 'Request',
  type: 'string',
  required: true,
  dynamic: 'request_list.id.label',
  search: 'find_request.id',
  helpText: 'The Request ID from a Create Request step, a Find Request step or a request trigger.',
}

const toIso = (ms) => new Date(ms).toISOString()

/**
 * The request methods return times as epoch milliseconds (docs/external-api.md
 * § Requests), while events carry ISO 8601 strings. Zapier formats, compares
 * and maps ISO strings as dates, so every `…At` time a request action returns,
 * and each `requests.get` timeline entry's `at`, leaves this app as one: the
 * same shape the triggers deliver.
 */
function withIsoTimes(request) {
  const converted = Object.fromEntries(
    Object.entries(request).map(([key, value]) => [key, key.endsWith('At') && typeof value === 'number' ? toIso(value) : value])
  )
  if (!Array.isArray(request.timeline)) return converted
  return { ...converted, timeline: request.timeline.map((entry) => ({ ...entry, at: toIso(entry.at) })) }
}

module.exports = { REQUEST_SUMMARY_OUTPUT_FIELDS, SAMPLE_REQUEST_SUMMARY, REQUEST_ID_INPUT_FIELD, withIsoTimes }
