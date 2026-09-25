'use strict'

const { createHmac } = require('crypto')
const http = require('http')
const https = require('https')

class RefreshAuthError extends Error {}
class ThrottledError extends Error {}

/**
 * A stand-in for Zapier's `z`: `z.request` performs a real HTTP request (so
 * nock or a local server can answer it) and parses JSON into `response.data`
 * the way zapier-platform-core does; `z.dehydrateFile` returns a readable
 * pointer instead of a hydration token; `z.cursor` keeps one string, as Zapier's
 * cursor store does between the pages of one dropdown.
 */
function makeZ({ cursor = null } = {}) {
  let storedCursor = cursor
  return {
    request: (options) => {
      const url = new URL(options.url)
      const transport = url.protocol === 'https:' ? https : http
      return new Promise((resolve, reject) => {
        const request = transport.request(
          {
            method: options.method || 'GET',
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: url.pathname + url.search,
            headers: options.headers || {},
          },
          (response) => {
            let content = ''
            response.on('data', (chunk) => (content += chunk))
            response.on('end', () => resolve({ status: response.statusCode, content, data: parseJson(content) }))
          }
        )
        request.on('error', reject)
        if (options.body) request.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body))
        request.end()
      })
    },
    dehydrateFile: (_hydrator, inputData) => `hydrate-file:${inputData.formId}:${inputData.submissionId}`,
    cursor: {
      get: async () => storedCursor,
      set: async (value) => {
        if (typeof value !== 'string') throw new TypeError('cursor value must be a string')
        storedCursor = value
      },
    },
    errors: { RefreshAuthError, ThrottledError },
  }
}

function parseJson(content) {
  try {
    return JSON.parse(content)
  } catch {
    return undefined
  }
}

function signEvent(secret, timestampSeconds, rawBody) {
  const digest = createHmac('sha256', secret).update(String(timestampSeconds)).update('.').update(rawBody).digest('hex')
  return `t=${timestampSeconds},sha256=${digest}`
}

/** The bundle Zapier hands `perform` for one signed formbase delivery. */
function makeSignedWebhookBundle(event, options = {}) {
  const signingSecret = options.signingSecret || `whsec_${'a'.repeat(64)}`
  const timestamp = options.timestamp || Math.floor(Date.now() / 1000)
  const content = options.content || JSON.stringify(event)
  return {
    cleanedRequest: event,
    subscribeData: { signingSecret },
    rawRequest: {
      headers: { 'Http-X-Formbase-Signature': signEvent(signingSecret, timestamp, content) },
      content,
    },
  }
}

module.exports = { makeZ, signEvent, makeSignedWebhookBundle, RefreshAuthError, ThrottledError }
