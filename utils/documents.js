'use strict'

const { createHash } = require('crypto')
const { formbaseRpc } = require('./request')

// The document types formbase accepts (docs/external-api.md § documents.create),
// by file extension, for a file whose download names no usable type.
const CONTENT_TYPE_BY_EXTENSION = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
}

const EXTENSION_BY_CONTENT_TYPE = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
}

// Content types a file host sends when it does not know what it serves.
const GENERIC_CONTENT_TYPES = new Set(['', 'application/octet-stream', 'binary/octet-stream', 'application/binary'])

/** The type the first bytes announce, for the common document formats. */
function sniffContentType(bytes) {
  const ascii = bytes.subarray(0, 12).toString('latin1')
  if (ascii.startsWith('%PDF-')) return 'application/pdf'
  if (ascii.startsWith('\x89PNG')) return 'image/png'
  if (ascii.startsWith('\xff\xd8\xff')) return 'image/jpeg'
  if (ascii.startsWith('GIF8')) return 'image/gif'
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return 'image/webp'
  return undefined
}

/** `filename*=UTF-8''…` or `filename="…"` from a Content-Disposition header. */
function filenameFromDisposition(disposition) {
  if (!disposition) return undefined
  const encoded = /filename\*\s*=\s*[^']*''([^;]+)/i.exec(disposition)
  if (encoded) return decodeURIComponent(encoded[1].trim())
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(disposition)
  return plain ? plain[1].trim() : undefined
}

/** The last path segment of the URL, when it looks like a file name. */
function filenameFromUrl(url) {
  const segment = decodeURIComponent(new URL(url).pathname.split('/').pop() || '')
  return /\.[A-Za-z0-9]+$/.test(segment) ? segment : undefined
}

function extensionOf(name) {
  const match = /\.([A-Za-z0-9]+)$/.exec(name || '')
  return match ? match[1].toLowerCase() : undefined
}

/**
 * What one file input holds: its bytes, the name the recipient sees and its
 * type. Zapier hands a file input over as a URL (a stashed or hydrated file,
 * or a link the Zap mapped). The name comes from the download's
 * Content-Disposition, else the URL; the type from the bytes (formbase checks
 * them too), else the response, else the name. A file whose type none of
 * them tell fails here,
 * before anything is reserved; a type formbase does not take is refused by
 * `documents.create` with DOCUMENT_TYPE_NOT_ALLOWED.
 */
async function downloadDocument(z, url, position) {
  if (typeof url !== 'string' || !/^https?:\/\//.test(url)) {
    throw new Error(`Document ${position} is not a file Zapier can download. Map a file, or a link to one.`)
  }
  const response = await z.request({ url, method: 'GET', raw: true, skipThrowForStatus: true })
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Document ${position} could not be downloaded (HTTP ${response.status}).`)
  }
  const bytes = await response.buffer()

  const headerType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
  const fileName = filenameFromDisposition(response.headers.get('content-disposition')) || filenameFromUrl(url)
  const declaredType = GENERIC_CONTENT_TYPES.has(headerType) ? CONTENT_TYPE_BY_EXTENSION[extensionOf(fileName)] : headerType
  const contentType = sniffContentType(bytes) || declaredType
  if (!contentType) {
    throw new Error(`Document ${position} has no file type formbase can tell. Documents are PDFs or images.`)
  }
  const extension = EXTENSION_BY_CONTENT_TYPE[contentType]
  const name = fileName || (extension ? `Document ${position}.${extension}` : `Document ${position}`)
  return { bytes, name, contentType }
}

/**
 * Reserves one document with `documents.create` and puts its bytes at the
 * presigned URL it answers with. `requests.create` later checks the object
 * against the declared size and sha256. The PUT carries no formbase token:
 * the URL is its own credential.
 */
async function uploadDocument(z, bundle, formId, { bytes, name, contentType }) {
  const reserved = await formbaseRpc({
    z,
    bundle,
    method: 'documents.create',
    params: { formId, name, contentType, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
  })
  const response = await z.request({
    url: reserved.uploadUrl,
    method: 'PUT',
    body: bytes,
    headers: { 'content-type': contentType },
    skipThrowForStatus: true,
  })
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Uploading "${name}" to formbase failed (HTTP ${response.status}).`)
  }
  return reserved.id
}

/**
 * The `documents` entries of `requests.create` for the files of one run, each
 * downloaded and uploaded in parallel. `field` names the Documents block when
 * the form has several; with one, formbase picks it.
 */
async function uploadDocuments(z, bundle, formId, files, field) {
  const documentIds = await Promise.all(
    files.map(async (url, index) => uploadDocument(z, bundle, formId, await downloadDocument(z, url, index + 1)))
  )
  return documentIds.map((documentId) => ({ documentId, ...(field ? { field } : {}) }))
}

module.exports = { uploadDocuments }
