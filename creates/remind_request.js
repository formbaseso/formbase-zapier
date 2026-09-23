'use strict'

const { formbaseRpc } = require('../utils/request')
const { REQUEST_SUMMARY_OUTPUT_FIELDS, SAMPLE_REQUEST_SUMMARY, REQUEST_ID_INPUT_FIELD } = require('../utils/request_summary')

async function perform(z, bundle) {
  return formbaseRpc({ z, bundle, method: 'requests.remind', params: { requestId: bundle.inputData.requestId } })
}

const create = {
  key: 'remind_request',
  noun: 'Request',
  display: {
    label: 'Remind Request',
    description: 'Emails the recipient a reminder now, outside the request’s reminder schedule.',
  },
  operation: {
    cleanInputData: false,
    inputFields: [
      {
        ...REQUEST_ID_INPUT_FIELD,
        helpText: `${REQUEST_ID_INPUT_FIELD.helpText} The request needs a recipient email and a workspace on Pro or above; at most one manual reminder every 10 minutes and eight reminders in total.`,
      },
    ],
    perform,
    sample: { ...SAMPLE_REQUEST_SUMMARY, remindersSent: 1 },
    outputFields: REQUEST_SUMMARY_OUTPUT_FIELDS,
  },
}

module.exports = create
