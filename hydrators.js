'use strict'

const { formbaseRpc } = require('./utils/request')

/**
 * Resolves the PDF File output lazily, when a later Zap step reads it.
 *
 * Returns a URL rather than the bytes: Zapier accepts a URL from a file
 * hydrator, and the formbase storage proxy re-signs the underlying object on
 * every request, so the link keeps working for as long as the PDF is retained.
 */
async function downloadSubmissionPdf(z, bundle) {
  const { formId, submissionId } = bundle.inputData
  const pdf = await formbaseRpc({ z, bundle, method: 'submissions.pdf', params: { formId, submissionId } })
  return pdf.url
}

module.exports = { downloadSubmissionPdf }
