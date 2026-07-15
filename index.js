'use strict';

const { version: platformVersion } = require('zapier-platform-core');
const { version } = require('./package.json');

const authentication = require('./authentication');
const hydrators = require('./hydrators');
const submission = require('./triggers/submission');
const formListTrigger = require('./triggers/form_list');

// Inject the OAuth Bearer token on every outbound request that doesn't already
// set one (utils/request sets it explicitly; this covers any other calls).
const includeBearerAuth = (request, z, bundle) => {
  const accessToken = bundle?.authData?.access_token;
  if (!accessToken) return request;
  request.headers = request.headers || {};
  if (!request.headers.authorization && !request.headers.Authorization) {
    request.headers.authorization = `Bearer ${accessToken}`;
  }
  return request;
};

const App = {
  version,
  platformVersion,
  authentication,
  hydrators,
  beforeRequest: [includeBearerAuth],
  afterResponse: [],
  triggers: {
    [submission.key]: submission,
    [formListTrigger.key]: formListTrigger,
  },
  searches: {},
  creates: {},
  resources: {},
};

module.exports = App;
