'use strict'

const { formbaseRpc } = require('./utils/request')

async function getSubmissionPdfUrl(z, bundle) {
  const formId = bundle.inputData.formId
  const submissionId = bundle.inputData.submissionId
  const pdf = await formbaseRpc({
    z,
    bundle,
    method: 'submissions.pdf',
    params: { formId, submissionId },
  })
  return pdf.url
}

async function downloadSubmissionPdf(z, bundle) {
  // Zapier file hydrators may return a permanent public URL. The Formbase
  // storage proxy refreshes the underlying R2 signed URL on every request.
  return getSubmissionPdfUrl(z, bundle)
}

module.exports = {
  getSubmissionPdfUrl,
  downloadSubmissionPdf,
}
