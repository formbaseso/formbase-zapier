'use strict'

const { formbaseRpc } = require('../utils/request')
const { listFields } = require('../utils/fields')

const DELIVERY_CHOICES = {
  none: 'None: the Zap sends the link itself',
  email: 'Email: formbase sends the invitation',
}

// Option-valued types whose answer is one option key …
const SINGLE_CHOICE_TYPES = new Set(['radio', 'select'])
// … or a list of option keys.
const MULTI_CHOICE_TYPES = new Set(['checkbox', 'ranking', 'picture-choice'])

const ZAPIER_TYPE_BY_FIELD_TYPE = {
  number: 'number',
  rating: 'number',
  scale: 'number',
  switch: 'boolean',
  date: 'datetime',
}

/**
 * The Zapier input key for one field key. A field key may contain `.` and `-`
 * (formbase allows `[A-Za-z0-9_.-]`), which a Zapier key may not, so those
 * become `_`. The payload is rebuilt by walking `fields.list` again rather than
 * by decoding, so the encoding does not need to be reversible; it only needs
 * to be unique within one form, which inputKeys checks.
 */
function inputKeyFor(prefix, ...keys) {
  return [prefix, ...keys.map((key) => key.replace(/[^A-Za-z0-9_]/g, '_'))].join('__')
}

function optionChoices(item) {
  return Object.fromEntries(item.options.map((option) => [option.key, option.label]))
}

/** The input for one plain (non-group, non-matrix) field, or a group member. */
function plainInput(item, key, label) {
  const base = { key, label, required: false, helpText: `Field key: ${item.key}` }
  if (SINGLE_CHOICE_TYPES.has(item.type)) return { ...base, type: 'string', choices: optionChoices(item) }
  if (MULTI_CHOICE_TYPES.has(item.type)) return { ...base, type: 'string', list: true, choices: optionChoices(item) }
  if (item.type === 'date') return { ...base, type: 'datetime', helpText: `${base.helpText}. Only the date part is sent.` }
  const type = ZAPIER_TYPE_BY_FIELD_TYPE[item.type] || 'string'
  return { ...base, type }
}

/**
 * The per-field inputs of one published form: one input per prefillable field
 * for `prefill`, one per hidden field for `context`, and a multi-select of
 * prefilled keys for `readonly`. Files, signatures, payments, appointments and
 * calculated fields are not prefillable and get no input.
 */
function fieldInputs(items) {
  const prefillChoices = {}
  const inputs = []
  for (const item of items) {
    if (item.context) {
      inputs.push({
        key: inputKeyFor('context', item.key),
        label: `${item.title} (context)`,
        type: 'string',
        required: false,
        helpText: `Hidden field ${item.key}: the recipient never sees or edits it, and it comes back in the answers.`,
      })
      continue
    }
    if (Array.isArray(item.members)) {
      const members = item.members.filter((member) => member.prefillable && !Array.isArray(member.rows))
      if (members.length === 0) continue
      inputs.push({
        key: inputKeyFor('prefill', item.key),
        label: item.key,
        required: false,
        helpText: `Repeating group ${item.key}: one line item per instance.`,
        children: members.map((member) => plainInput(member, inputKeyFor('prefill', item.key, member.key), member.title)),
      })
      prefillChoices[item.key] = item.key
      continue
    }
    if (!item.prefillable) continue
    if (Array.isArray(item.rows)) {
      const columns = Object.fromEntries(item.columns.map((column) => [column.key, column.label]))
      for (const row of item.rows) {
        inputs.push({
          key: inputKeyFor('prefill', item.key, row.key),
          label: `${item.title} › ${row.label}`,
          type: 'string',
          required: false,
          choices: columns,
          helpText: `Field key: ${item.key}, row ${row.key}`,
        })
      }
      prefillChoices[item.key] = item.title
      continue
    }
    inputs.push(plainInput(item, inputKeyFor('prefill', item.key), item.title))
    prefillChoices[item.key] = item.title
  }

  if (Object.keys(prefillChoices).length > 0) {
    inputs.push({
      key: 'readonly',
      label: 'Read-only fields',
      type: 'string',
      list: true,
      required: false,
      choices: prefillChoices,
      helpText: 'Prefilled fields the recipient may see but not change. Each one must also be prefilled above.',
    })
  }
  return inputs
}

async function getFieldInputs(z, bundle) {
  const formId = bundle.inputData.formId
  if (!formId) return []
  const items = await listFields(z, bundle, formId)
  const inputs = fieldInputs(items)
  const keys = inputs.flatMap((input) => [input.key, ...(input.children || []).map((child) => child.key)])
  const duplicate = keys.find((key, index) => keys.indexOf(key) !== index)
  if (duplicate) {
    throw new Error(`Two field keys of this form map to the same input (${duplicate}). Rename one of them in the editor.`)
  }
  return inputs
}

// ─── payload ────────────────────────────────────────────────────────────────

function isBlank(value) {
  return value === undefined || value === null || value === ''
}

/** Zapier hands a mapped value as a string; the API wants the shape fields.list names. */
function coerce(item, value) {
  if (item.type === 'date') return String(value).slice(0, 10)
  if (ZAPIER_TYPE_BY_FIELD_TYPE[item.type] === 'number') return typeof value === 'string' ? Number(value) : value
  if (item.type === 'switch') {
    if (value === 'true') return true
    if (value === 'false') return false
    return value
  }
  if (MULTI_CHOICE_TYPES.has(item.type)) return (Array.isArray(value) ? value : [value]).filter((entry) => !isBlank(entry))
  return value
}

function plainValue(item, value) {
  if (isBlank(value)) return undefined
  const coerced = coerce(item, value)
  if (Array.isArray(coerced) && coerced.length === 0) return undefined
  return coerced
}

/** The `prefill` and `context` maps, from the inputs fieldInputs offered for these items. */
function buildFieldValues(items, inputData) {
  const prefill = {}
  const context = {}
  for (const item of items) {
    if (item.context) {
      const value = inputData[inputKeyFor('context', item.key)]
      if (!isBlank(value)) context[item.key] = value
      continue
    }
    if (Array.isArray(item.members)) {
      const rows = inputData[inputKeyFor('prefill', item.key)]
      if (!Array.isArray(rows)) continue
      const instances = rows
        .map((row) => {
          const instance = {}
          for (const member of item.members) {
            const value = plainValue(member, row[inputKeyFor('prefill', item.key, member.key)])
            if (value !== undefined) instance[member.key] = value
          }
          return instance
        })
        .filter((instance) => Object.keys(instance).length > 0)
      if (instances.length > 0) prefill[item.key] = instances
      continue
    }
    if (Array.isArray(item.rows)) {
      const matrix = {}
      for (const row of item.rows) {
        const value = inputData[inputKeyFor('prefill', item.key, row.key)]
        if (!isBlank(value)) matrix[row.key] = value
      }
      if (Object.keys(matrix).length > 0) prefill[item.key] = matrix
      continue
    }
    const value = plainValue(item, inputData[inputKeyFor('prefill', item.key)])
    if (value !== undefined) prefill[item.key] = value
  }
  return { prefill, context }
}

function parseExpiresAt(value) {
  const expiresAt = Date.parse(value)
  if (Number.isNaN(expiresAt)) throw new Error(`Expires At is not a date Zapier could parse: ${value}`)
  return expiresAt
}

function nonBlankList(value) {
  if (isBlank(value)) return []
  return (Array.isArray(value) ? value : [value]).filter((entry) => !isBlank(entry))
}

/**
 * The `requests.create` params for one run. `idempotencyKey` is the external
 * id, so a replayed or re-run Zap gets the request it already created back
 * (`deduplicated: true`) instead of sending the recipient a second link.
 */
async function buildCreateParams(z, bundle) {
  const input = bundle.inputData
  const items = await listFields(z, bundle, input.formId)
  const { prefill, context } = buildFieldValues(items, input)
  const readonly = nonBlankList(input.readonly)
  const reminders = nonBlankList(input.reminders)
  const recipient = {
    ...(isBlank(input.recipientEmail) ? {} : { email: input.recipientEmail }),
    ...(isBlank(input.recipientName) ? {} : { name: input.recipientName }),
  }
  const metadata = input.metadata && typeof input.metadata === 'object' ? input.metadata : {}

  return {
    formId: input.formId,
    ...(Object.keys(recipient).length > 0 ? { recipient } : {}),
    ...(isBlank(input.language) ? {} : { language: input.language }),
    ...(Object.keys(context).length > 0 ? { context } : {}),
    ...(Object.keys(prefill).length > 0 ? { prefill } : {}),
    ...(readonly.length > 0 ? { readonly } : {}),
    ...(isBlank(input.externalId) ? {} : { externalId: input.externalId, idempotencyKey: input.externalId }),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    ...(isBlank(input.delivery) ? {} : { delivery: input.delivery }),
    ...(reminders.length > 0 ? { reminders } : {}),
    ...(isBlank(input.expiresAt) ? {} : { expiresAt: parseExpiresAt(input.expiresAt) }),
    ...(input.test === true ? { test: true } : {}),
  }
}

async function perform(z, bundle) {
  const params = await buildCreateParams(z, bundle)
  return formbaseRpc({ z, bundle, method: 'requests.create', params })
}

const create = {
  key: 'create_request',
  noun: 'Request',
  display: {
    label: 'Create Request',
    description: 'Creates a request: assigns a published form to one recipient and returns the link to complete it.',
  },
  operation: {
    cleanInputData: false,
    inputFields: [
      {
        key: 'formId',
        label: 'Form',
        type: 'string',
        required: true,
        dynamic: 'form_list.id.name',
        altersDynamicFields: true,
        helpText: 'The published form the recipient will complete. Its field keys appear below once it is chosen.',
      },
      {
        key: 'recipientEmail',
        label: 'Recipient Email',
        type: 'string',
        required: false,
        helpText: 'Required for email delivery and reminders.',
      },
      { key: 'recipientName', label: 'Recipient Name', type: 'string', required: false },
      {
        key: 'language',
        label: 'Language',
        type: 'string',
        required: false,
        helpText: 'A published language of the form, like en or de. Leave empty for the form default.',
      },
      {
        key: 'delivery',
        label: 'Delivery',
        type: 'string',
        required: false,
        choices: DELIVERY_CHOICES,
        default: 'none',
        helpText: 'With None, send the Request URL this step returns through your own channel.',
      },
      {
        key: 'reminders',
        label: 'Reminders',
        type: 'string',
        list: true,
        required: false,
        helpText: 'Idle offsets like 2d or 5d, up to five. Leave empty to keep the form’s reminder schedule.',
      },
      {
        key: 'expiresAt',
        label: 'Expires At',
        type: 'datetime',
        required: false,
        helpText: 'Defaults to 30 days from now; at most 365 days.',
      },
      {
        key: 'externalId',
        label: 'External ID',
        type: 'string',
        required: false,
        helpText:
          'Your id for this request, for Find Request later. It is also the idempotency key: a re-run Zap with the same External ID and inputs gets the same request back instead of creating a second one.',
      },
      {
        key: 'metadata',
        label: 'Metadata',
        dict: true,
        required: false,
        helpText: 'Caller-only bookkeeping. Never shown to the recipient; echoed on every request event.',
      },
      {
        key: 'test',
        label: 'Test Request',
        type: 'boolean',
        required: false,
        helpText: 'A test request sends no email, counts against no quota and fires triggers with Test Event set.',
      },
      getFieldInputs,
    ],
    perform,
    sample: {
      id: 'req_example000000000000',
      status: 'pending',
      url: 'https://forms.formbase.so/r/rq_example',
      deliveryStatus: 'not_requested',
      expiresAt: 1782388800000,
      createdAt: 1779796800000,
      externalId: 'run-42',
      deduplicated: false,
    },
    outputFields: [
      { key: 'id', label: 'Request ID', type: 'string' },
      { key: 'status', label: 'Status', type: 'string' },
      { key: 'url', label: 'Request URL', type: 'string' },
      { key: 'deliveryStatus', label: 'Delivery Status', type: 'string' },
      { key: 'expiresAt', label: 'Expires At (ms)', type: 'number' },
      { key: 'createdAt', label: 'Created At (ms)', type: 'number' },
      { key: 'externalId', label: 'External ID', type: 'string' },
      { key: 'deduplicated', label: 'Deduplicated', type: 'boolean' },
    ],
  },
}

module.exports = create
