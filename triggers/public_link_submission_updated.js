'use strict'

const { createPublicLinkSubmissionTrigger } = require('../utils/public_link_submission_trigger')

module.exports = createPublicLinkSubmissionTrigger({
  event: 'updated',
  key: 'public_link_submission_updated',
  label: 'Public Link Submission Updated',
  description:
    'Triggers when a respondent edits a submission they already sent through the public link. The form must allow editing after submit.',
})
