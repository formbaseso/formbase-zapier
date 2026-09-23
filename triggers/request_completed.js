'use strict'

const { createRequestTrigger } = require('../utils/request_trigger')

module.exports = createRequestTrigger({
  outcome: 'completed',
  label: 'Request Completed',
  description:
    'Triggers when a recipient completes a request. The answers arrive keyed by field key, with the outcome.',
  helpText:
    'The form whose completed requests fire this Zap. A completed request fires this trigger only, never Public Link Submission.',
})
