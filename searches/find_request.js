'use strict'

const { formbaseRpc } = require('../utils/request')
const { getWorkspace } = require('../utils/dropdowns')
const { REQUEST_SUMMARY_OUTPUT_FIELDS, SAMPLE_REQUEST_SUMMARY } = require('../utils/request_summary')

/**
 * `requests.list` needs a form or a workspace scope. With no form picked the
 * search covers the connection's whole workspace, which is what an external id
 * is scoped to. Newest first; an empty list is Zapier's "not found".
 */
async function perform(z, bundle) {
  const { formId, externalId, includeTest } = bundle.inputData
  const scope = formId ? { formId } : { workspaceId: (await getWorkspace(z, bundle)).id }
  const { items } = await formbaseRpc({
    z,
    bundle,
    method: 'requests.list',
    params: { ...scope, externalId, ...(includeTest === true ? { includeTest: true } : {}) },
  })
  return items
}

const search = {
  key: 'find_request',
  noun: 'Request',
  display: {
    label: 'Find Request',
    description: 'Finds requests by the External ID a Create Request step gave them.',
  },
  operation: {
    cleanInputData: false,
    inputFields: [
      {
        key: 'externalId',
        label: 'External ID',
        type: 'string',
        required: true,
        helpText: 'The External ID set when the request was created.',
      },
      {
        key: 'formId',
        label: 'Form',
        type: 'string',
        required: false,
        dynamic: 'form_list.id.label',
        helpText: 'Optional. Narrows the search to one form; otherwise the whole workspace is searched.',
      },
      {
        key: 'includeTest',
        label: 'Include Test Requests',
        type: 'boolean',
        required: false,
        helpText: 'Requests created with Test Request on are left out unless this is on.',
      },
    ],
    perform,
    sample: SAMPLE_REQUEST_SUMMARY,
    outputFields: REQUEST_SUMMARY_OUTPUT_FIELDS,
  },
}

module.exports = search
