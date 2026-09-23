/**
 * The whole trigger against a formbase API speaking real HTTP: pick a form,
 * label its outputs, subscribe, receive a signed delivery, hydrate the PDF,
 * unsubscribe. Nothing is mocked below `z.request`.
 */
const { FakeFormbase, ACCESS_TOKEN } = require('./fake-formbase')
const { makeZ } = require('./helpers')

const FIELDS = [
  { key: 'company_name', type: 'text', title: 'Company', required: true, prefillable: true },
  { key: 'plan', type: 'select', title: 'Plan', required: false, prefillable: true, options: [{ key: 'pro', label: 'Pro' }] },
  { key: 'contacts', type: 'group', repeating: true, members: [{ key: 'name', type: 'text', title: 'Name', required: true, prefillable: true }] },
]

let formbase
let trigger
let hydrators
let formList
const z = makeZ()
const authData = { access_token: ACCESS_TOKEN }

beforeAll(async () => {
  formbase = await new FakeFormbase({
    forms: [
      { id: 'form_live', name: 'Vendor onboarding', published: true },
      { id: 'form_draft', name: 'Draft', published: false },
    ],
    fields: { form_live: FIELDS },
  }).start()
  // utils/request reads BASE_URL at load, so the app is required after the server is up.
  process.env.BASE_URL = formbase.baseUrl
  jest.isolateModules(() => {
    trigger = require('../triggers/submission')
    hydrators = require('../hydrators')
    formList = require('../triggers/form_list')
  })
})

afterAll(() => formbase.stop())

test('a Zap goes from form picker to delivered submission and back to unsubscribed', async () => {
  // 1. The form picker lists the workspace's forms.
  const forms = await formList.operation.perform(z, { authData })
  expect(forms).toEqual([
    { id: 'form_live', name: 'Vendor onboarding' },
    { id: 'form_draft', name: 'Draft' },
  ])

  // 2. The Zap editor labels outputs from the published field list.
  const outputs = await trigger.operation.outputFields[0](z, { authData, inputData: { formId: 'form_live' } })
  expect(outputs.map((field) => field.label)).toEqual(
    expect.arrayContaining(['Company', 'Plan (display)', 'contacts › Name', 'Request ID'])
  )

  // 3. Testing the trigger fetches a sample of the same shape.
  const [sample] = await trigger.operation.performList(z, { authData, inputData: { formId: 'form_live', eventType: 'submission_created' } })
  expect(sample).toMatchObject({ type: 'submission.completed', test: true, data: { form: { id: 'form_live', snapshotId: 'snap_form_live' } } })

  // 4. Turning the Zap on registers a signed subscription.
  const subscribeData = await trigger.operation.performSubscribe(z, {
    authData,
    targetUrl: 'https://hooks.zapier.com/hooks/standard/1',
    inputData: { formId: 'form_live', eventType: 'submission_created' },
  })
  expect(formbase.subscriptions.get(subscribeData.id)).toMatchObject({
    provider: 'zapier',
    eventType: 'submission_created',
    signingSecret: subscribeData.signingSecret,
  })

  // 5. formbase delivers a submission; the Zap verifies it and hydrates the PDF lazily.
  const event = formbase.buildEvent({
    formId: 'form_live',
    answers: { company_name: 'Acme', plan: 'pro', contacts: [{ name: 'Ada' }] },
    display: { company_name: 'Acme', plan: 'Pro', contacts: 'Ada' },
    pdfUrl: formbase.pdfUrl,
    request: { id: 'req_1', externalId: 'run-42' },
  })
  const delivery = formbase.deliver(subscribeData.id, event)
  const [item] = await trigger.operation.perform(z, {
    authData,
    subscribeData,
    cleanedRequest: JSON.parse(delivery.content),
    rawRequest: { headers: delivery.headers, content: delivery.content },
  })
  expect(item.data.answers).toEqual({ company_name: 'Acme', plan: 'pro', contacts: [{ name: 'Ada' }] })
  expect(item.data.display.plan).toBe('Pro')
  expect(item.data.request).toEqual({ id: 'req_1', externalId: 'run-42' })
  expect(item.data.submission.pdfFile).toBe('hydrate-file:form_live:sub_1')

  await expect(hydrators.downloadSubmissionPdf(z, { authData, inputData: { formId: 'form_live', submissionId: 'sub_1' } })).resolves.toBe(formbase.pdfUrl)

  // 6. A delivery signed with another secret never reaches the Zap.
  const forged = { ...delivery, headers: { ...delivery.headers, 'x-formbase-signature': delivery.headers['x-formbase-signature'].replace(/sha256=.*/, `sha256=${'0'.repeat(64)}`) } }
  await expect(
    trigger.operation.perform(z, { authData, subscribeData, cleanedRequest: event, rawRequest: { headers: forged.headers, content: forged.content } })
  ).rejects.toThrow(/webhook signature/i)

  // 7. Turning the Zap off removes the subscription.
  await trigger.operation.performUnsubscribe(z, { authData, subscribeData })
  expect(formbase.subscriptions.size).toBe(0)
})

test('an abandoned-submission Zap registers its idle window and tests against submission.abandoned', async () => {
  const subscribeData = await trigger.operation.performSubscribe(z, {
    authData,
    targetUrl: 'https://hooks.zapier.com/hooks/standard/2',
    inputData: { formId: 'form_live', eventType: 'submission_abandoned', idleWindow: '3d' },
  })
  expect(formbase.subscriptions.get(subscribeData.id)).toMatchObject({ eventType: 'submission_abandoned', idleWindow: '3d' })

  const [sample] = await trigger.operation.performList(z, { authData, inputData: { formId: 'form_live', eventType: 'submission_abandoned' } })
  expect(sample.type).toBe('submission.abandoned')

  await trigger.operation.performUnsubscribe(z, { authData, subscribeData })
})

test('a Zap on an unpublished form still gets the envelope outputs', async () => {
  const outputs = await trigger.operation.outputFields[0](z, { authData, inputData: { formId: 'form_draft' } })
  expect(outputs.map((field) => field.key)).toContain('data__form__name')
  expect(outputs.some((field) => field.key.startsWith('data__answers__'))).toBe(false)
})

test('an expired token surfaces as RefreshAuthError so Zapier refreshes it', async () => {
  await expect(
    trigger.operation.performList(z, { authData: { access_token: 'fbo_expired' }, inputData: { formId: 'form_live', eventType: 'submission_created' } })
  ).rejects.toBeInstanceOf(z.errors.RefreshAuthError)
})
