// BASE_URL is read at module load in utils/request, so set it before requiring.
process.env.BASE_URL = 'https://fake.formbase.test'

const { createHash } = require('crypto')
const nock = require('nock')
const create = require('../creates/create_request')
const { makeZ } = require('./helpers')

const FAKE_BASE = process.env.BASE_URL
const FILES = 'https://files.example.test'
const STORAGE = 'https://storage.example.test'
const authData = { access_token: 'fbo_access' }

// Both carry bytes that are not UTF-8, as real files do (a PDF's second line is
// a binary comment), so nock hands the uploaded body over hex-encoded.
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n%'), Buffer.from([0xe2, 0xe3, 0xcf, 0xd3]), Buffer.from('\n1 0 obj\n<<>>\nendobj\n')])
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('rest of the image')])

const ONE_BLOCK = [
  { key: 'company_name', type: 'text', title: 'Company', required: true, prefillable: true },
  { key: 'contract_documents', type: 'documents', title: 'Your contract', required: false, prefillable: false },
]
const TWO_BLOCKS = [...ONE_BLOCK, { key: 'price_lists', type: 'documents', title: 'Price lists', required: false, prefillable: false }]

const fieldInputs = create.operation.inputFields.find((field) => typeof field === 'function')

function rpc(method, predicate = () => true) {
  return nock(FAKE_BASE).post('/api/v1', (body) => {
    if (body.method !== method) return false
    return predicate(body.params)
  })
}

function fieldsList(items) {
  return rpc('fields.list').reply(200, { ok: true, data: { published: true, hasMore: false, items } })
}

/**
 * Answers every documents.create with a numbered reservation and records what
 * was reserved and what bytes reached storage, keyed by document id.
 */
function storage() {
  const reserved = {}
  const uploaded = {}
  let next = 1
  rpc('documents.create')
    .times(10)
    .reply(200, (_uri, body) => {
      const id = `doc_${next++}`
      reserved[id] = body.params
      return { ok: true, data: { id, name: body.params.name, uploadUrl: `${STORAGE}/upload/${id}` } }
    })
  nock(STORAGE)
    .put(/\/upload\/doc_\d+/)
    .times(10)
    .reply(function (uri, body) {
      const id = uri.split('/').pop()
      uploaded[id] = { bytes: Buffer.from(body, 'hex'), contentType: this.req.headers['content-type'], authorization: this.req.headers.authorization }
      return [200, '']
    })
  return { reserved, uploaded }
}

function captureCreate() {
  const captured = {}
  rpc('requests.create', (params) => {
    captured.params = params
    return true
  }).reply(200, { ok: true, data: { id: 'req_1', status: 'pending', url: 'https://forms.formbase.test/r/rq_1', deduplicated: false } })
  return captured
}

function perform(inputData) {
  return create.operation.perform(makeZ(), { authData, inputData: { formId: 'form_1', ...inputData } })
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

afterEach(() => nock.cleanAll())

describe('Documents inputs', () => {
  test('a form without a Documents block offers none', async () => {
    fieldsList([ONE_BLOCK[0]])

    const inputs = await fieldInputs(makeZ(), { authData, inputData: { formId: 'form_1' } })

    expect(inputs.map((input) => input.key)).not.toContain('documents')
  })

  test('a form with one block offers a list of files and no block picker', async () => {
    fieldsList(ONE_BLOCK)

    const inputs = await fieldInputs(makeZ(), { authData, inputData: { formId: 'form_1' } })

    expect(inputs.find((input) => input.key === 'documents')).toMatchObject({ type: 'file', list: true, required: false })
    expect(inputs.map((input) => input.key)).not.toContain('documentsBlock')
  })

  test('a form with several blocks also asks which block the files go into', async () => {
    fieldsList(TWO_BLOCKS)

    const inputs = await fieldInputs(makeZ(), { authData, inputData: { formId: 'form_1' } })

    expect(inputs.find((input) => input.key === 'documentsBlock')).toMatchObject({
      choices: { contract_documents: 'Your contract', price_lists: 'Price lists' },
    })
  })
})

describe('Create Request with documents', () => {
  test('reserves, uploads and attaches each file, named and typed from its download', async () => {
    fieldsList(ONE_BLOCK)
    nock(FILES).get('/abc123').reply(200, PDF, { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="Lease contract.pdf"' })
    nock(FILES).get('/scans/floor-plan.png').reply(200, PNG, { 'content-type': 'image/png' })
    const { reserved, uploaded } = storage()
    const captured = captureCreate()

    await perform({ documents: [`${FILES}/abc123`, `${FILES}/scans/floor-plan.png`] })

    // Uploads run in parallel, but the documents keep the order the files were given in.
    const attached = captured.params.documents.map(({ documentId }) => reserved[documentId])
    expect(attached).toEqual([
      { formId: 'form_1', name: 'Lease contract.pdf', contentType: 'application/pdf', size: PDF.length, sha256: sha256(PDF) },
      { formId: 'form_1', name: 'floor-plan.png', contentType: 'image/png', size: PNG.length, sha256: sha256(PNG) },
    ])
    for (const [id, params] of Object.entries(reserved)) {
      expect(uploaded[id].contentType).toBe(params.contentType)
      expect(sha256(uploaded[id].bytes)).toBe(params.sha256)
      // The presigned URL is its own credential; the formbase token stays home.
      expect(uploaded[id].authorization).toBeUndefined()
    }
    expect(captured.params.documents).toEqual([{ documentId: expect.stringMatching(/^doc_/) }, { documentId: expect.stringMatching(/^doc_/) }])
  })

  test('reads the type from the bytes when the file host does not know it, and names an unnamed file by it', async () => {
    fieldsList(ONE_BLOCK)
    nock(FILES).get('/stash/9f8e7d').reply(200, PDF, { 'content-type': 'binary/octet-stream' })
    const { reserved } = storage()
    captureCreate()

    await perform({ documents: `${FILES}/stash/9f8e7d` })

    expect(Object.values(reserved)).toEqual([expect.objectContaining({ name: 'Document 1.pdf', contentType: 'application/pdf' })])
  })

  test('sends the picked block when the form has several', async () => {
    fieldsList(TWO_BLOCKS)
    nock(FILES).get('/prices.pdf').reply(200, PDF, { 'content-type': 'application/pdf' })
    storage()
    const captured = captureCreate()

    await perform({ documents: [`${FILES}/prices.pdf`], documentsBlock: 'price_lists' })

    expect(captured.params.documents).toEqual([{ documentId: 'doc_1', field: 'price_lists' }])
  })

  test('refuses files for a form with several blocks and none picked, before downloading anything', async () => {
    fieldsList(TWO_BLOCKS)
    const download = nock(FILES).get('/prices.pdf').reply(200, PDF)

    await expect(perform({ documents: [`${FILES}/prices.pdf`] })).rejects.toThrow(/several Documents blocks/)
    expect(download.isDone()).toBe(false)
  })

  test('refuses files for a form without a Documents block', async () => {
    fieldsList([ONE_BLOCK[0]])

    await expect(perform({ documents: [`${FILES}/prices.pdf`] })).rejects.toThrow(/no Documents block/)
  })

  test('uploads nothing when another input is wrong', async () => {
    fieldsList(ONE_BLOCK)
    const download = nock(FILES).get('/prices.pdf').reply(200, PDF)

    await expect(perform({ documents: [`${FILES}/prices.pdf`], expiresAt: 'not a date' })).rejects.toThrow(/Expires At/)
    expect(download.isDone()).toBe(false)
  })

  test('fails with the position of a file that could not be downloaded, and creates no request', async () => {
    fieldsList(ONE_BLOCK)
    nock(FILES).get('/gone.pdf').reply(404, 'Not found')
    const created = rpc('requests.create').reply(200, { ok: true, data: {} })

    await expect(perform({ documents: [`${FILES}/gone.pdf`] })).rejects.toThrow('Document 1 could not be downloaded (HTTP 404).')
    expect(created.isDone()).toBe(false)
  })

  test('fails on a value that is not a file link', async () => {
    fieldsList(ONE_BLOCK)

    await expect(perform({ documents: ['just some text'] })).rejects.toThrow(/Document 1 is not a file Zapier can download/)
  })

  test('fails on a file whose type nothing tells', async () => {
    fieldsList(ONE_BLOCK)
    nock(FILES).get('/blob').reply(200, Buffer.from('plain bytes'), { 'content-type': 'application/octet-stream' })

    await expect(perform({ documents: [`${FILES}/blob`] })).rejects.toThrow(/no file type formbase can tell/)
  })

  test('surfaces a failed upload with the file name', async () => {
    fieldsList(ONE_BLOCK)
    nock(FILES).get('/contract.pdf').reply(200, PDF, { 'content-type': 'application/pdf' })
    rpc('documents.create').reply(200, { ok: true, data: { id: 'doc_1', uploadUrl: `${STORAGE}/upload/doc_1` } })
    nock(STORAGE).put('/upload/doc_1').reply(403, 'Signature expired')

    await expect(perform({ documents: [`${FILES}/contract.pdf`] })).rejects.toThrow('Uploading "contract.pdf" to formbase failed (HTTP 403).')
  })
})
