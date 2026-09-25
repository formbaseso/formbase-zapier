'use strict'

const { listRequests } = require('../utils/dropdowns')

// Hidden helper trigger behind every Request ID dropdown (`request_list.id.label`).
module.exports = {
  key: 'request_list',
  noun: 'Request',
  display: {
    label: 'List Requests',
    description: 'Internal: lists the newest formbase requests for the request picker dropdown.',
    hidden: true,
  },
  operation: {
    perform: listRequests,
    canPaginate: true,
    sample: { id: 'req_example000000000000', label: 'ada@example.com · pending · run-42' },
  },
}
