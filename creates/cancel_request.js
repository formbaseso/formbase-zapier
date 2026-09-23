'use strict'

const { formbaseRpc } = require('../utils/request')
const { REQUEST_SUMMARY_OUTPUT_FIELDS, SAMPLE_REQUEST_SUMMARY, REQUEST_ID_INPUT_FIELD } = require('../utils/request_summary')

async function perform(z, bundle) {
  const { requestId, reason } = bundle.inputData
  return formbaseRpc({
    z,
    bundle,
    method: 'requests.cancel',
    params: { requestId, ...(reason ? { reason } : {}) },
  })
}

const create = {
  key: 'cancel_request',
  noun: 'Request',
  display: {
    label: 'Cancel Request',
    description: 'Cancels a pending request: the link stops working and Request Canceled fires.',
  },
  operation: {
    cleanInputData: false,
    inputFields: [
      REQUEST_ID_INPUT_FIELD,
      {
        key: 'reason',
        label: 'Reason',
        type: 'string',
        required: false,
        helpText: 'Kept on the request and carried by the Request Canceled event.',
      },
    ],
    perform,
    sample: { ...SAMPLE_REQUEST_SUMMARY, status: 'canceled', canceledAt: 1779883200000, canceledBy: 'api', cancelReason: 'Order withdrawn' },
    outputFields: REQUEST_SUMMARY_OUTPUT_FIELDS,
  },
}

module.exports = create
