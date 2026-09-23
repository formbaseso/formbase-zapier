'use strict'

const { createRequestTrigger } = require('../utils/request_trigger')

module.exports = createRequestTrigger({
  outcome: 'expired',
  label: 'Request Expired',
  description: 'Triggers when a request expires before the recipient completes it.',
  helpText: 'The form whose expired requests fire this Zap.',
})
