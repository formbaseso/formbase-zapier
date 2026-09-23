'use strict'

const { createPublicLinkSubmissionTrigger } = require('../utils/public_link_submission_trigger')

// Keeps the key 2.x gave its single trigger, whose default event was created.
module.exports = createPublicLinkSubmissionTrigger({
  event: 'created',
  key: 'public_link_submission',
  label: 'Public Link Submission Created',
  description:
    'Triggers when a respondent submits the form through its public link. A completed request fires Request Completed instead.',
})
