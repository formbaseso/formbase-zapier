'use strict'

// Deployment origin. Defaults to formbase cloud; override via the BASE_URL
// Zapier env var for a self-hosted deployment. Must match the origin whose
// /oauth/* endpoints back this integration's OAuth config.
const BASE_URL = String(process.env.BASE_URL || 'https://api.formbase.so').replace(/\/+$/, '')

/**
 * Call a formbase JSON-RPC method.
 *
 * @param {object} args
 * @param {object} args.z - Zapier z object (provides z.request and z.errors)
 * @param {object} args.bundle - Zapier bundle with authData (OAuth access_token)
 * @param {string} args.method - JSON-RPC method name
 * @param {object} [args.params] - Method params
 * @returns {Promise<*>} the `data` field from a successful response
 */
async function formbaseRpc({ z, bundle, method, params }) {
  const url = `${BASE_URL}/api/v1`
  const accessToken = bundle?.authData?.access_token

  const response = await z.request({
    url,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${accessToken}`,
      accept: 'application/json',
    },
    body: JSON.stringify({ method, params: params || {} }),
    skipThrowForStatus: true,
  })

  let payload = response.json
  if (!payload && response.data) {
    try {
      payload = JSON.parse(response.data)
    } catch (_e) {
      payload = null
    }
  }

  if (payload?.ok === true) {
    return payload.data
  }

  const code = payload?.error?.code || `HTTP_${response.status || 'UNKNOWN'}`
  const message = payload?.error?.message || `formbase API error (${code})`

  if (code === 'UNAUTHORIZED') {
    throw new z.errors.RefreshAuthError(message)
  }
  if (code === 'RATE_LIMITED') {
    throw new z.errors.ThrottledError(message)
  }
  throw new Error(`${code}: ${message}`)
}

module.exports = { formbaseRpc, BASE_URL }
