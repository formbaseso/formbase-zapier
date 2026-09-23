'use strict'

const { createPublicLinkSubmissionTrigger } = require('../utils/public_link_submission_trigger')

module.exports = createPublicLinkSubmissionTrigger({
  event: 'abandoned',
  key: 'public_link_submission_abandoned',
  label: 'Public Link Submission Abandoned',
  description:
    'Triggers when a respondent starts the form through its public link and leaves it unfinished. Needs partial-submission tracking on the workspace.',
})
