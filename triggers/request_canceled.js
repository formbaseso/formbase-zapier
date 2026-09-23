'use strict'

const { createRequestTrigger } = require('../utils/request_trigger')

module.exports = createRequestTrigger({
  outcome: 'canceled',
  label: 'Request Canceled',
  description: 'Triggers when a request is canceled, from the dashboard, the API or a Cancel Request step.',
  helpText: 'Choose the form whose canceled requests should fire this Zap.',
})
