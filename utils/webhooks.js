'use strict'

const { createHmac, randomBytes, timingSafeEqual } = require('crypto')
const { formbaseRpc } = require('./request')

const SIGNATURE_HEADER_PATTERN = /^t=(\d+),sha256=([a-f0-9]{64})$/
const SIGNATURE_MAX_AGE_SECONDS = 5 * 60

/**
 * Registers a REST hook subscription for one form and event type. The server
 * rejects a bad combination with a readable VALIDATION_ERROR, so nothing is
 * re-validated here. `params` carries whatever the event type needs on top of
 * `eventType` (an abandoned-submission subscription adds its `idleWindow`).
 *
 * Returns what Zapier stores as `bundle.subscribeData`: the subscription id and
 * the signing secret, which `webhooks.create` never echoes back.
 */
async function subscribe(z, bundle, params) {
  const signingSecret = createWebhookSigningSecret()
  const data = await formbaseRpc({
    z,
    bundle,
    method: 'webhooks.create',
    params: { formId: bundle.inputData.formId, targetUrl: bundle.targetUrl, provider: 'zapier', ...params, signingSecret },
  })
  return { id: data.subscriptionId, signingSecret }
}

async function unsubscribe(z, bundle) {
  return formbaseRpc({ z, bundle, method: 'webhooks.delete', params: { subscriptionId: bundle.subscribeData.id } })
}

/** Throws unless the delivery is signed with this subscription's secret and is fresh. */
function requireVerifiedDelivery(bundle) {
  if (!verifyWebhookSignature(bundle)) {
    throw new Error('Invalid or expired formbase webhook signature.')
  }
}

function createWebhookSigningSecret() {
  return `whsec_${randomBytes(32).toString('hex')}`
}

function findSignatureHeader(headers) {
  if (!headers || typeof headers !== 'object') return undefined
  const entry = Object.entries(headers).find(([name]) => {
    const normalizedName = name.toLowerCase()
    return normalizedName === 'http-x-formbase-signature' || normalizedName === 'x-formbase-signature'
  })
  return entry?.[1]
}

function verifyWebhookSignature(bundle) {
  const secret = bundle.subscribeData?.signingSecret
  if (typeof secret !== 'string' || secret.length === 0) return false

  const signatureHeader = findSignatureHeader(bundle.rawRequest?.headers)
  if (typeof signatureHeader !== 'string') return false

  const match = SIGNATURE_HEADER_PATTERN.exec(signatureHeader)
  if (!match) return false

  const [, timestamp, signatureHex] = match
  const timestampSeconds = Number(timestamp)
  if (!Number.isSafeInteger(timestampSeconds)) return false

  const currentTimestampSeconds = Math.floor(Date.now() / 1000)
  if (Math.abs(currentTimestampSeconds - timestampSeconds) > SIGNATURE_MAX_AGE_SECONDS) return false

  const rawBody = bundle.rawRequest?.content
  if (typeof rawBody !== 'string' && !Buffer.isBuffer(rawBody)) return false

  const expectedSignature = createHmac('sha256', secret).update(timestamp).update('.').update(rawBody).digest()
  const receivedSignature = Buffer.from(signatureHex, 'hex')

  return expectedSignature.length === receivedSignature.length && timingSafeEqual(expectedSignature, receivedSignature)
}

module.exports = { subscribe, unsubscribe, requireVerifiedDelivery, verifyWebhookSignature }
