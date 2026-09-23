'use strict'

const { formbaseRpc } = require('../utils/request')
const { listFields, answerOutputFields } = require('../utils/fields')
const { REQUEST_SUMMARY_OUTPUT_FIELDS, SAMPLE_REQUEST_SUMMARY, REQUEST_ID_INPUT_FIELD } = require('../utils/request_summary')

// `requests.get` adds the link and, once completed, the answers to the summary.
const REQUEST_VIEW_OUTPUT_FIELDS = [
  ...REQUEST_SUMMARY_OUTPUT_FIELDS,
  { key: 'url', label: 'Request URL', type: 'string' },
]

/**
 * The answer outputs come from the form's field list, and the form is only
 * known once the request is fetched. The optional Form input names it at
 * editor time so the outputs can be labelled by question; without it the Zap
 * still runs, and the answers arrive under `answers__<key>` unlabelled.
 */
async function outputFields(z, bundle) {
  const formId = bundle.inputData.formId
  if (!formId) return REQUEST_VIEW_OUTPUT_FIELDS

  const items = await listFields(z, bundle, formId)
  return [...REQUEST_VIEW_OUTPUT_FIELDS, ...items.flatMap((item) => answerOutputFields(item, ''))]
}

async function perform(z, bundle) {
  return formbaseRpc({ z, bundle, method: 'requests.get', params: { requestId: bundle.inputData.requestId } })
}

const create = {
  key: 'get_request',
  noun: 'Request',
  display: {
    label: 'Get Request',
    description: 'Fetches a request by id, with its status, outcome and, once completed, the answers keyed by field key.',
  },
  operation: {
    cleanInputData: false,
    inputFields: [
      REQUEST_ID_INPUT_FIELD,
      {
        key: 'formId',
        label: 'Form',
        type: 'string',
        required: false,
        dynamic: 'form_list.id.name',
        altersDynamicFields: true,
        helpText: 'Optional. Pick the request’s form so the answer outputs are labelled with its questions.',
      },
    ],
    perform,
    sample: {
      ...SAMPLE_REQUEST_SUMMARY,
      status: 'completed',
      outcome: 'approve',
      submissionId: 'sub_xyz789',
      completedAt: 1779883200000,
      url: 'https://forms.formbase.so/r/rq_example',
      answers: { case_id: 'CASE-9', company_name: 'Acme', decision: 'approve' },
      display: { case_id: 'CASE-9', company_name: 'Acme', decision: 'Approve' },
      timeline: [{ id: 'req_example000000000000:created', at: 1779796800000, type: 'created' }],
    },
    outputFields: [outputFields],
  },
}

module.exports = create
