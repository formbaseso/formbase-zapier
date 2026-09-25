'use strict'

const { listForms } = require('../utils/dropdowns')

// Hidden helper trigger behind every Form dropdown (`form_list.id.label`).
module.exports = {
  key: 'form_list',
  noun: 'Form',
  display: {
    label: 'List Forms',
    description: 'Internal: lists formbase forms for the form picker dropdown.',
    hidden: true,
  },
  operation: {
    perform: listForms,
    sample: { id: 'form_abc123', label: 'Customer Feedback' },
  },
}
