'use strict'

const { listForms } = require('../utils/list_forms')

// Hidden helper trigger that powers the `formId` dynamic dropdown on the
// `submission` trigger via the `form_list.id.name` reference.
const formListTrigger = {
  key: 'form_list',
  noun: 'Form',
  display: {
    label: 'List Forms',
    description: 'Internal: lists formbase forms for the form picker dropdown.',
    hidden: true,
  },
  operation: {
    perform: listForms,
    sample: { id: 'form_abc123', name: 'Customer Feedback' },
  },
}

module.exports = formListTrigger
