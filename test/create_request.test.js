// BASE_URL is read at module load in utils/request, so set it before requiring.
process.env.BASE_URL = 'https://fake.formbase.test'

const nock = require('nock')
const create = require('../creates/create_request')
const { makeZ } = require('./helpers')

const FAKE_BASE = process.env.BASE_URL
const authData = { access_token: 'fbo_access' }

// One of every field shape fields.list reports (docs/external-api.md § fields.list).
const FIELDS = [
  { key: 'company_name', type: 'text', title: 'Company', required: true, prefillable: true },
  { key: 'seats', type: 'number', title: 'Seats', required: false, prefillable: true },
  { key: 'newsletter', type: 'switch', title: 'Newsletter', required: false, prefillable: true },
  { key: 'start-date', type: 'date', title: 'Start date', required: false, prefillable: true },
  { key: 'plan', type: 'select', title: 'Plan', required: false, prefillable: true, options: [{ key: 'pro', label: 'Pro' }, { key: 'team', label: 'Team' }] },
  { key: 'addons', type: 'checkbox', title: 'Add-ons', required: false, prefillable: true, options: [{ key: 'sso', label: 'SSO' }, { key: 'audit', label: 'Audit log' }] },
  {
    key: 'satisfaction',
    type: 'matrix',
    title: 'How did we do?',
    required: false,
    prefillable: true,
    rows: [{ key: 'delivery_speed', label: 'Delivery speed' }, { key: 'support', label: 'Support' }],
    columns: [{ key: 'very_good', label: 'Very good' }, { key: 'poor', label: 'Poor' }],
  },
  { key: 'case_id', type: 'hidden', title: 'Case', required: false, prefillable: false, context: true },
  { key: 'total', type: 'number', title: 'Total', required: false, prefillable: false, calculated: true },
  { key: 'contract', type: 'file', title: 'Contract', required: false, prefillable: false },
  {
    key: 'contacts',
    type: 'group',
    repeating: true,
    members: [
      { key: 'name', type: 'text', title: 'Name', required: true, prefillable: true },
      { key: 'role', type: 'radio', title: 'Role', required: false, prefillable: true, options: [{ key: 'owner', label: 'Owner' }] },
    ],
  },
]

function rpc(method, predicate = () => true) {
  return nock(FAKE_BASE).post('/api/v1', (body) => {
    if (body.method !== method) return false
    return predicate(body.params)
  })
}

const fieldInputs = create.operation.inputFields.find((field) => typeof field === 'function')

function fieldsList(items = FIELDS) {
  return rpc('fields.list', (params) => params.formId === 'form_1').reply(200, { ok: true, data: { published: true, hasMore: false, items } })
}

/** Runs perform against a fake formbase and returns the requests.create params it sent. */
async function createParamsFor(inputData) {
  fieldsList()
  let sent
  rpc('requests.create', (params) => {
    sent = params
    return true
  }).reply(200, { ok: true, data: { id: 'req_1', status: 'pending', url: 'https://forms.formbase.test/r/rq_1', deduplicated: false } })
  const result = await create.operation.perform(makeZ(), { authData, inputData: { formId: 'form_1', ...inputData } })
  return { sent, result }
}

describe('create_request definition', () => {
  test('is keyed create_request with a form picker that reloads the field inputs', () => {
    expect(create.key).toBe('create_request')
    expect(create.operation.cleanInputData).toBe(false)
    const formField = create.operation.inputFields.find((field) => field.key === 'formId')
    expect(formField).toMatchObject({ required: true, dynamic: 'form_list.id.label', altersDynamicFields: true })
    expect(create.operation.inputFields.map((field) => field.key)).toEqual(
      expect.arrayContaining(['recipientEmail', 'recipientName', 'language', 'delivery', 'reminders', 'expiresAt', 'externalId', 'metadata', 'test'])
    )
    expect(create.operation.inputFields.find((field) => field.key === 'metadata').dict).toBe(true)
    expect(create.operation.inputFields.find((field) => field.key === 'delivery')).toMatchObject({ choices: { none: expect.any(String), email: expect.any(String) }, default: 'none' })
    expect(create.operation.sample.url).toBeTruthy()
    expect(create.operation.outputFields.map((field) => field.key)).toContain('url')
  })
})

describe('field inputs (from fields.list)', () => {
  afterEach(() => nock.cleanAll())

  test('offers nothing before a form is chosen', async () => {
    await expect(fieldInputs(makeZ(), { authData, inputData: {} })).resolves.toEqual([])
  })

  test('offers one labelled input per prefillable key, per hidden field, and a read-only multi-select', async () => {
    fieldsList()
    const inputs = await fieldInputs(makeZ(), { authData, inputData: { formId: 'form_1' } })
    const byKey = Object.fromEntries(inputs.map((input) => [input.key, input]))

    expect(byKey.prefill__company_name).toMatchObject({ label: 'Company', type: 'string', required: false, helpText: 'Field key: company_name' })
    expect(byKey.prefill__seats).toMatchObject({ type: 'number' })
    expect(byKey.prefill__newsletter).toMatchObject({ type: 'boolean' })
    // A field key may hold `-` and `.`; a Zapier key may not.
    expect(byKey['prefill__start_date']).toMatchObject({ label: 'Start date', type: 'datetime' })
    expect(byKey.prefill__plan).toMatchObject({ type: 'string', choices: { pro: 'Pro', team: 'Team' } })
    expect(byKey.prefill__addons).toMatchObject({ list: true, choices: { sso: 'SSO', audit: 'Audit log' } })
    expect(byKey.prefill__satisfaction__delivery_speed).toMatchObject({ label: 'How did we do? › Delivery speed', choices: { very_good: 'Very good', poor: 'Poor' } })
    expect(byKey.prefill__satisfaction__support).toBeDefined()
    expect(byKey.context__case_id).toMatchObject({ label: 'Case (context)', type: 'string' })
    expect(byKey.prefill__contacts.children.map((child) => child.key)).toEqual(['prefill__contacts__name', 'prefill__contacts__role'])
    expect(byKey.prefill__contacts.children[1].choices).toEqual({ owner: 'Owner' })
    expect(byKey.readonly).toMatchObject({
      list: true,
      choices: { company_name: 'Company', seats: 'Seats', newsletter: 'Newsletter', 'start-date': 'Start date', plan: 'Plan', addons: 'Add-ons', satisfaction: 'How did we do?', contacts: 'contacts' },
    })
    // Calculated fields and files cannot be sent, so they get no input.
    expect(Object.keys(byKey)).not.toEqual(expect.arrayContaining(['prefill__total', 'prefill__contract']))
    expect(inputs[inputs.length - 1].key).toBe('readonly')
  })

  test('offers no field inputs for a form that is not published yet', async () => {
    rpc('fields.list').reply(200, { ok: true, data: { published: false, items: [], hasMore: false } })
    await expect(fieldInputs(makeZ(), { authData, inputData: { formId: 'form_1' } })).resolves.toEqual([])
  })

  test('fails loudly when two field keys collapse onto the same input key', async () => {
    fieldsList([
      { key: 'a-b', type: 'text', title: 'A dash B', required: false, prefillable: true },
      { key: 'a_b', type: 'text', title: 'A underscore B', required: false, prefillable: true },
    ])
    await expect(fieldInputs(makeZ(), { authData, inputData: { formId: 'form_1' } })).rejects.toThrow(/prefill__a_b/)
  })
})

describe('perform (requests.create)', () => {
  afterEach(() => nock.cleanAll())

  test('sends prefill and context keyed by field key, in the shapes fields.list names', async () => {
    const { sent, result } = await createParamsFor({
      recipientEmail: 'ada@example.com',
      recipientName: 'Ada',
      language: 'de',
      delivery: 'email',
      prefill__company_name: 'Acme',
      prefill__seats: '12',
      prefill__newsletter: 'true',
      prefill__start_date: '2026-03-04T00:00:00+01:00',
      prefill__plan: 'pro',
      prefill__addons: ['sso', ''],
      prefill__satisfaction__delivery_speed: 'very_good',
      prefill__satisfaction__support: '',
      context__case_id: 'CASE-9',
      prefill__contacts: [{ prefill__contacts__name: 'Ada', prefill__contacts__role: 'owner' }, { prefill__contacts__name: '', prefill__contacts__role: '' }],
      readonly: ['company_name', ''],
    })

    expect(sent).toEqual({
      formId: 'form_1',
      recipient: { email: 'ada@example.com', name: 'Ada' },
      language: 'de',
      delivery: 'email',
      context: { case_id: 'CASE-9' },
      prefill: {
        company_name: 'Acme',
        seats: 12,
        newsletter: true,
        'start-date': '2026-03-04',
        plan: 'pro',
        addons: ['sso'],
        satisfaction: { delivery_speed: 'very_good' },
        contacts: [{ name: 'Ada', role: 'owner' }],
      },
      readonly: ['company_name'],
    })
    expect(result).toMatchObject({ id: 'req_1', url: 'https://forms.formbase.test/r/rq_1' })
  })

  test('derives idempotencyKey from externalId, so a re-run Zap reuses the request', async () => {
    const { sent } = await createParamsFor({ externalId: 'run-42' })
    expect(sent).toMatchObject({ externalId: 'run-42', idempotencyKey: 'run-42' })
  })

  test('sends no idempotencyKey, and no empty maps, when nothing was filled in', async () => {
    const { sent } = await createParamsFor({ recipientEmail: '', externalId: '', metadata: {}, reminders: [], readonly: [] })
    expect(sent).toEqual({ formId: 'form_1' })
  })

  test('passes reminders, expiry, metadata and test mode through', async () => {
    const { sent } = await createParamsFor({
      reminders: ['2d', '5d'],
      expiresAt: '2026-10-01T00:00:00Z',
      metadata: { runId: 'run-42' },
      test: true,
    })
    expect(sent).toEqual({ formId: 'form_1', reminders: ['2d', '5d'], expiresAt: Date.parse('2026-10-01T00:00:00Z'), metadata: { runId: 'run-42' }, test: true })
  })

  test('fails on an expiry Zapier could not turn into a date', async () => {
    fieldsList()
    await expect(create.operation.perform(makeZ(), { authData, inputData: { formId: 'form_1', expiresAt: 'someday' } })).rejects.toThrow(/Expires At/)
  })

  test('surfaces a formbase validation error with its code', async () => {
    fieldsList()
    rpc('requests.create').reply(400, { ok: false, error: { code: 'VALIDATION_ERROR', message: 'INVALID_PREFILL_VALUE: plan expects an option key' } })
    await expect(create.operation.perform(makeZ(), { authData, inputData: { formId: 'form_1', prefill__plan: 'Pro' } })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })
})
