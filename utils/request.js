'use strict'

// Deployment origin. Defaults to formbase cloud; override via the BASE_URL
// Zapier env var for a self-hosted deployment. Must match the origin whose
// /oauth/* endpoints back this integration's OAuth config.
const BASE_URL = String(process.env.BASE_URL || 'https://api.formbase.so').replace(/\/+$/, '')

/**
 * Call a formbase JSON-RPC method and return its `data`.
 *
 * The API answers `{ ok: true, data }` or `{ ok: false, error: { code, message } }`.
 * UNAUTHORIZED becomes RefreshAuthError so Zapier refreshes the token and
 * retries; RATE_LIMITED becomes ThrottledError so Zapier backs off. Every other
 * failure throws an Error carrying the formbase `code`, so a caller can branch
 * on it without matching message text.
 */
async function formbaseRpc({ z, bundle, method, params }) {
  const response = await z.request({
    url: `${BASE_URL}/api/v1`,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${bundle.authData.access_token}`,
      accept: 'application/json',
    },
    body: JSON.stringify({ method, params: params || {} }),
    skipThrowForStatus: true,
  })

  // z.request parses a JSON body into response.data; anything else leaves it undefined.
  const payload = response.data
  if (payload?.ok === true) return payload.data

  const code = payload?.error?.code || `HTTP_${response.status || 'UNKNOWN'}`
  const message = payload?.error?.message || `formbase API error (${code})`
  if (code === 'UNAUTHORIZED') throw new z.errors.RefreshAuthError(message)
  if (code === 'RATE_LIMITED') throw new z.errors.ThrottledError(message)

  const error = new Error(`${code}: ${message}`)
  error.code = code
  throw error
}

module.exports = { formbaseRpc, BASE_URL }
