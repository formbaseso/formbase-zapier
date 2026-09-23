'use strict'

const { formbaseRpc } = require('./request')

const ZAPIER_TYPE_BY_FIELD_TYPE = {
  number: 'number',
  rating: 'number',
  scale: 'number',
  switch: 'boolean',
  date: 'datetime',
}

/**
 * The form's published field list (`fields.list`). A form that is not
 * published yet has no field list (`published: false`, no items), so a Zap can
 * still be wired up on the envelope alone; that comes back as an empty list.
 */
async function listFields(z, bundle, formId) {
  const { items } = await formbaseRpc({ z, bundle, method: 'fields.list', params: { formId } })
  return items
}

/**
 * One Zapier output field per answer, from one `fields.list` item:
 * `<prefix>answers__<key>` carries the stored value, `<prefix>display__<key>`
 * the readable text. A repeating group's members are line items under the
 * group key; a matrix answers one field per row.
 *
 * `prefix` is where the two maps live in the payload: `data__` in an event
 * envelope, empty in a `requests.get` result.
 */
function answerOutputFields(item, prefix) {
  if (Array.isArray(item.members)) {
    // A group has no title of its own; its key is what the caller addresses it by.
    return [
      ...item.members.map((member) => ({
        key: `${prefix}answers__${item.key}[]${member.key}`,
        label: `${item.key} › ${member.title}`,
      })),
      { key: `${prefix}display__${item.key}`, label: `${item.key} (display)`, type: 'string' },
    ]
  }
  const display = { key: `${prefix}display__${item.key}`, label: `${item.title} (display)`, type: 'string' }
  if (Array.isArray(item.rows)) {
    // A matrix answer is `{ row_key: column_key }`, which Zapier flattens per row.
    return [
      ...item.rows.map((row) => ({
        key: `${prefix}answers__${item.key}__${row.key}`,
        label: `${item.title} › ${row.label}`,
        type: 'string',
      })),
      display,
    ]
  }
  const type = ZAPIER_TYPE_BY_FIELD_TYPE[item.type]
  return [{ key: `${prefix}answers__${item.key}`, label: item.title, ...(type ? { type } : {}) }, display]
}

module.exports = { listFields, answerOutputFields }
