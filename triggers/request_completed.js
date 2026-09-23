'use strict'

const { createRequestTrigger } = require('../utils/request_trigger')

module.exports = createRequestTrigger({
  outcome: 'completed',
  label: 'Request Completed',
  description: 'Triggers when a recipient completes a request: the answers arrive keyed by field key, with the outcome.',
  helpText:
    'Choose the form whose requests should fire this Zap. A completed request also fires the Submission trigger, so a Zap on both receives two events.',
})
