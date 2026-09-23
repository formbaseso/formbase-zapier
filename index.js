'use strict'

const { version: platformVersion } = require('zapier-platform-core')
const { version } = require('./package.json')

const authentication = require('./authentication')
const hydrators = require('./hydrators')
const publicLinkSubmissionCreated = require('./triggers/public_link_submission_created')
const publicLinkSubmissionUpdated = require('./triggers/public_link_submission_updated')
const publicLinkSubmissionAbandoned = require('./triggers/public_link_submission_abandoned')
const requestCompleted = require('./triggers/request_completed')
const requestExpired = require('./triggers/request_expired')
const requestCanceled = require('./triggers/request_canceled')
const formList = require('./triggers/form_list')
const createRequest = require('./creates/create_request')
const cancelRequest = require('./creates/cancel_request')
const remindRequest = require('./creates/remind_request')
const getRequest = require('./creates/get_request')
const findRequest = require('./searches/find_request')

// Every formbase call goes through utils/request, which sets the Bearer header
// itself. No beforeRequest middleware: one would also run on the OAuth token
// and refresh requests, where a stale access token has no business being sent.
module.exports = {
  version,
  platformVersion,
  authentication,
  hydrators,
  triggers: {
    [publicLinkSubmissionCreated.key]: publicLinkSubmissionCreated,
    [publicLinkSubmissionUpdated.key]: publicLinkSubmissionUpdated,
    [publicLinkSubmissionAbandoned.key]: publicLinkSubmissionAbandoned,
    [requestCompleted.key]: requestCompleted,
    [requestExpired.key]: requestExpired,
    [requestCanceled.key]: requestCanceled,
    [formList.key]: formList,
  },
  creates: {
    [createRequest.key]: createRequest,
    [cancelRequest.key]: cancelRequest,
    [remindRequest.key]: remindRequest,
    [getRequest.key]: getRequest,
  },
  searches: {
    [findRequest.key]: findRequest,
  },
}
