'use strict'

const { formbaseRpc } = require('./request')

const ZAPIER_TYPE_BY_FIELD_TYPE = {
  number: 'number',
  rating: 'number',
  scale: 'number',
  switch: 'boolean',
  date: 'datetime',
}

// A booking and a payment answer are objects (docs/external-api.md § Events,
// "Bookings and payments"), which Zapier flattens per property: one output
// field each, so a Zap maps the start time or the amount on its own.
const OBJECT_ANSWER_PROPERTIES = {
  'schedule-appointment': [
    { path: 'status', label: 'Status', type: 'string' },
    { path: 'start', label: 'Start', type: 'datetime' },
    { path: 'end', label: 'End', type: 'datetime' },
    { path: 'timeZone', label: 'Time Zone', type: 'string' },
    { path: 'attendee__name', label: 'Attendee Name', type: 'string' },
    { path: 'attendee__email', label: 'Attendee Email', type: 'string' },
    { path: 'meetingUrl', label: 'Meeting URL', type: 'string' },
    { path: 'eventTitle', label: 'Event Title', type: 'string' },
    { path: 'provider', label: 'Provider', type: 'string' },
    { path: 'providerBookingId', label: 'Provider Booking ID', type: 'string' },
  ],
  payment: [
    { path: 'status', label: 'Status', type: 'string' },
    { path: 'amount', label: 'Amount', type: 'number' },
    { path: 'currency', label: 'Currency', type: 'string' },
    { path: 'amountRefunded', label: 'Amount Refunded', type: 'number' },
    { path: 'receiptUrl', label: 'Receipt URL', type: 'string' },
    { path: 'paidAt', label: 'Paid At', type: 'datetime' },
    { path: 'refundedAt', label: 'Refunded At', type: 'datetime' },
    { path: 'disputedAt', label: 'Disputed At', type: 'datetime' },
    { path: 'provider', label: 'Provider', type: 'string' },
    { path: 'providerPaymentIntentId', label: 'Provider Payment Intent ID', type: 'string' },
  ],
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
 * group key; a matrix answers one field per row; a booking or a payment one
 * field per property.
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
  const properties = OBJECT_ANSWER_PROPERTIES[item.type]
  if (properties) {
    return [
      ...properties.map((property) => ({
        key: `${prefix}answers__${item.key}__${property.path}`,
        label: `${item.title} › ${property.label}`,
        type: property.type,
      })),
      display,
    ]
  }
  const type = ZAPIER_TYPE_BY_FIELD_TYPE[item.type]
  return [{ key: `${prefix}answers__${item.key}`, label: item.title, ...(type ? { type } : {}) }, display]
}

module.exports = { listFields, answerOutputFields }
