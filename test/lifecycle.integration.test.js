/**
 * The whole app against a formbase API speaking real HTTP: pick a form,
 * label its outputs, subscribe, receive a signed delivery, hydrate the PDF,
 * unsubscribe; then create, find, remind, cancel and watch a request.
 * Nothing is mocked below `z.request`.
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
let updatedTrigger
let abandonedTrigger
let hydrators
let formList
let requestCompleted
let requestCanceled
let createRequest
let getRequest
let findRequest
let cancelRequest
let remindRequest
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
    trigger = require('../triggers/public_link_submission_created')
    updatedTrigger = require('../triggers/public_link_submission_updated')
    abandonedTrigger = require('../triggers/public_link_submission_abandoned')
    hydrators = require('../hydrators')
    formList = require('../triggers/form_list')
    requestCompleted = require('../triggers/request_completed')
    requestCanceled = require('../triggers/request_canceled')
    createRequest = require('../creates/create_request')
    getRequest = require('../creates/get_request')
    findRequest = require('../searches/find_request')
    cancelRequest = require('../creates/cancel_request')
    remindRequest = require('../creates/remind_request')
  })
})

afterAll(() => formbase.stop())

test('a Zap goes from form picker to delivered submission and back to unsubscribed', async () => {
  // 1. The form picker lists the workspace's forms.
  const forms = await formList.operation.perform(z, { authData })
  expect(forms).toEqual([
    { id: 'form_live', label: 'Vendor onboarding' },
    { id: 'form_draft', label: 'Draft (not published)' },
  ])

  // 2. The Zap editor labels outputs from the published field list.
  const outputs = await trigger.operation.outputFields[0](z, { authData, inputData: { formId: 'form_live' } })
  expect(outputs.map((field) => field.label)).toEqual(
    expect.arrayContaining(['Company', 'Plan (display)', 'contacts › Name'])
  )

  // 3. Testing the trigger fetches a sample of the same shape.
  const [sample] = await trigger.operation.performList(z, { authData, inputData: { formId: 'form_live' } })
  expect(sample).toMatchObject({ type: 'submission.completed', test: true, data: { form: { id: 'form_live', snapshotId: 'snap_form_live' } } })

  // 4. Turning the Zap on registers a signed subscription.
  const subscribeData = await trigger.operation.performSubscribe(z, {
    authData,
    targetUrl: 'https://hooks.zapier.com/hooks/standard/1',
    inputData: { formId: 'form_live' },
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
  const subscribeData = await abandonedTrigger.operation.performSubscribe(z, {
    authData,
    targetUrl: 'https://hooks.zapier.com/hooks/standard/2',
    inputData: { formId: 'form_live', idleWindow: '3d' },
  })
  expect(formbase.subscriptions.get(subscribeData.id)).toMatchObject({ eventType: 'submission_abandoned', idleWindow: '3d' })

  const [sample] = await abandonedTrigger.operation.performList(z, { authData, inputData: { formId: 'form_live' } })
  expect(sample.type).toBe('submission.abandoned')

  await abandonedTrigger.operation.performUnsubscribe(z, { authData, subscribeData })
})

test('an updated-submission Zap registers without an idle window and tests against submission.updated', async () => {
  const subscribeData = await updatedTrigger.operation.performSubscribe(z, {
    authData,
    targetUrl: 'https://hooks.zapier.com/hooks/standard/3',
    inputData: { formId: 'form_live' },
  })
  const subscription = formbase.subscriptions.get(subscribeData.id)
  expect(subscription).toMatchObject({ eventType: 'submission_updated' })
  expect(subscription).not.toHaveProperty('idleWindow')

  const [sample] = await updatedTrigger.operation.performList(z, { authData, inputData: { formId: 'form_live' } })
  expect(sample.type).toBe('submission.updated')

  await updatedTrigger.operation.performUnsubscribe(z, { authData, subscribeData })
})

test('a Zap on an unpublished form still gets the envelope outputs', async () => {
  const outputs = await trigger.operation.outputFields[0](z, { authData, inputData: { formId: 'form_draft' } })
  expect(outputs.map((field) => field.key)).toContain('data__form__name')
  expect(outputs.some((field) => field.key.startsWith('data__answers__'))).toBe(false)
})

test('an expired token surfaces as RefreshAuthError so Zapier refreshes it', async () => {
  await expect(
    trigger.operation.performList(z, { authData: { access_token: 'fbo_expired' }, inputData: { formId: 'form_live' } })
  ).rejects.toBeInstanceOf(z.errors.RefreshAuthError)
})

test('a Zap creates a request, watches it complete, finds it again and cancels a second one', async () => {
  // 1. The Create Request editor offers one input per prefillable key from the field list.
  const fieldInputs = createRequest.operation.inputFields.find((field) => typeof field === 'function')
  const inputs = await fieldInputs(z, { authData, inputData: { formId: 'form_live' } })
  expect(inputs.map((input) => input.key)).toEqual(['prefill__company_name', 'prefill__plan', 'prefill__contacts', 'readonly'])

  // 2. Running it creates a pending request; the external id doubles as idempotency key.
  const inputData = {
    formId: 'form_live',
    recipientEmail: 'ada@example.com',
    recipientName: 'Ada',
    externalId: 'run-42',
    metadata: { runId: 'run-42' },
    prefill__company_name: 'Acme',
    prefill__plan: 'pro',
    prefill__contacts: [{ prefill__contacts__name: 'Ada' }],
    readonly: ['company_name'],
  }
  const created = await createRequest.operation.perform(z, { authData, inputData })
  expect(created).toMatchObject({ id: 'req_1', status: 'pending', externalId: 'run-42', deduplicated: false })
  expect(created.url).toMatch(/^https:\/\/forms\.formbase\.test\/r\//)
  expect(formbase.requests.get('req_1')).toMatchObject({
    prefill: { company_name: 'Acme', plan: 'pro', contacts: [{ name: 'Ada' }] },
    readonlyKeys: ['company_name'],
    recipient: { email: 'ada@example.com', name: 'Ada' },
  })

  // 3. A replayed Zap run (same external id, same inputs) reuses the request instead of creating a second one.
  await expect(createRequest.operation.perform(z, { authData, inputData })).resolves.toMatchObject({ id: 'req_1', deduplicated: true })
  await expect(createRequest.operation.perform(z, { authData, inputData: { ...inputData, recipientName: 'Grace' } })).rejects.toMatchObject({ code: 'CONFLICT' })

  // 4. Find Request locates it by external id; Remind Request nudges the recipient.
  await expect(findRequest.operation.perform(z, { authData, inputData: { externalId: 'run-42', formId: 'form_live' } })).resolves.toEqual([expect.objectContaining({ id: 'req_1' })])
  await expect(findRequest.operation.perform(z, { authData, inputData: { externalId: 'run-42' } })).resolves.toHaveLength(1)
  await expect(findRequest.operation.perform(z, { authData, inputData: { externalId: 'nobody' } })).resolves.toEqual([])
  await expect(remindRequest.operation.perform(z, { authData, inputData: { requestId: 'req_1' } })).resolves.toMatchObject({ remindersSent: 1 })

  // 5. A Request Completed Zap subscribes to request_completed and labels answers from the form.
  const outputs = await requestCompleted.operation.outputFields[0](z, { authData, inputData: { formId: 'form_live' } })
  expect(outputs.map((field) => field.key)).toEqual(expect.arrayContaining(['data__request__outcome', 'data__answers__company_name', 'data__submission__pdfFile']))
  const [sample] = await requestCompleted.operation.performList(z, { authData, inputData: { formId: 'form_live' } })
  expect(sample).toMatchObject({ type: 'request.completed', test: true, data: { request: { status: 'completed' }, form: { id: 'form_live' } } })

  const subscribeData = await requestCompleted.operation.performSubscribe(z, {
    authData,
    targetUrl: 'https://hooks.zapier.com/hooks/standard/3',
    inputData: { formId: 'form_live' },
  })
  expect(formbase.subscriptions.get(subscribeData.id)).toMatchObject({ provider: 'zapier', eventType: 'request_completed' })

  // 6. The recipient completes the request; the signed delivery becomes the Zap item, PDF included.
  const completed = formbase.buildRequestEvent({
    formId: 'form_live',
    status: 'completed',
    request: { id: 'req_1', metadata: { runId: 'run-42' } },
    answers: { company_name: 'Acme', plan: 'pro', contacts: [{ name: 'Ada' }] },
    display: { company_name: 'Acme', plan: 'Pro', contacts: 'Ada' },
    pdfUrl: formbase.pdfUrl,
  })
  const delivery = formbase.deliver(subscribeData.id, completed)
  const [item] = await requestCompleted.operation.perform(z, {
    authData,
    subscribeData,
    cleanedRequest: JSON.parse(delivery.content),
    rawRequest: { headers: delivery.headers, content: delivery.content },
  })
  expect(item.data.request).toMatchObject({ id: 'req_1', status: 'completed', outcome: 'approve', externalId: 'run-42' })
  expect(item.data.answers.company_name).toBe('Acme')
  expect(item.data.submission.pdfFile).toBe('hydrate-file:form_live:sub_1')

  // 7. A canceled event on the completed subscription is refused even though it is signed.
  const wrongType = formbase.deliver(subscribeData.id, formbase.buildRequestEvent({ formId: 'form_live', status: 'canceled' }))
  await expect(
    requestCompleted.operation.perform(z, { authData, subscribeData, cleanedRequest: JSON.parse(wrongType.content), rawRequest: { headers: wrongType.headers, content: wrongType.content } })
  ).rejects.toThrow(/request\.canceled event to a request\.completed subscription/)
  await requestCompleted.operation.performUnsubscribe(z, { authData, subscribeData })

  // 8. Get Request reads the request back; a second request is canceled with a reason and fires Request Canceled.
  const view = await getRequest.operation.perform(z, { authData, inputData: { requestId: 'req_1' } })
  expect(view).toMatchObject({ id: 'req_1', url: created.url, remindersSent: 1 })

  const second = await createRequest.operation.perform(z, { authData, inputData: { formId: 'form_live', externalId: 'run-43' } })
  const canceled = await cancelRequest.operation.perform(z, { authData, inputData: { requestId: second.id, reason: 'Order withdrawn' } })
  expect(canceled).toMatchObject({ id: second.id, status: 'canceled', cancelReason: 'Order withdrawn', canceledBy: 'api' })
  await expect(cancelRequest.operation.perform(z, { authData, inputData: { requestId: second.id } })).rejects.toMatchObject({ code: 'CONFLICT' })
  await expect(remindRequest.operation.perform(z, { authData, inputData: { requestId: second.id } })).rejects.toMatchObject({ code: 'CONFLICT' })

  const canceledSubscription = await requestCanceled.operation.performSubscribe(z, { authData, targetUrl: 'https://hooks.zapier.com/hooks/standard/4', inputData: { formId: 'form_live' } })
  const canceledDelivery = formbase.deliver(canceledSubscription.id, formbase.buildRequestEvent({ formId: 'form_live', status: 'canceled', request: { id: second.id, externalId: 'run-43' } }))
  const [canceledItem] = await requestCanceled.operation.perform(z, {
    authData,
    subscribeData: canceledSubscription,
    cleanedRequest: JSON.parse(canceledDelivery.content),
    rawRequest: { headers: canceledDelivery.headers, content: canceledDelivery.content },
  })
  expect(canceledItem.data).toEqual({ request: expect.objectContaining({ id: second.id, status: 'canceled', cancelReason: 'Order withdrawn' }) })
  await requestCanceled.operation.performUnsubscribe(z, { authData, subscribeData: canceledSubscription })
  expect(formbase.subscriptions.size).toBe(0)
})

test('a request on an unpublished form is refused with the form-not-published reason', async () => {
  await expect(createRequest.operation.perform(z, { authData, inputData: { formId: 'form_draft' } })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
})
