'use strict'

const { version: platformVersion } = require('zapier-platform-core')
const { version } = require('./package.json')

const authentication = require('./authentication')
const hydrators = require('./hydrators')
const submission = require('./triggers/submission')
const formList = require('./triggers/form_list')

// Every formbase call goes through utils/request, which sets the Bearer header
// itself. No beforeRequest middleware: one would also run on the OAuth token
// and refresh requests, where a stale access token has no business being sent.
module.exports = {
  version,
  platformVersion,
  authentication,
  hydrators,
  triggers: {
    [submission.key]: submission,
    [formList.key]: formList,
  },
}
