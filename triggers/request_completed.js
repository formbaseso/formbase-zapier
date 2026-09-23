'use strict'

const { createRequestTrigger } = require('../utils/request_trigger')

module.exports = createRequestTrigger({
  outcome: 'completed',
  label: 'Request Completed',
  description:
    'Triggers when a recipient completes a request: the answers arrive keyed by field key, with the outcome. The only event a completed request fires.',
  helpText:
    'Choose the form whose requests should fire this Zap. A completed request fires this trigger alone, never the Public Link Submission trigger, so a Zap on each receives one event per completion.',
})
