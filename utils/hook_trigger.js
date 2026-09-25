'use strict'

const { subscribe, unsubscribe, requireVerifiedDelivery } = require('./webhooks')
const { listFields, answerOutputFields } = require('./fields')
const { addPdfFileHydrator } = require('./events')

/**
 * A REST hook trigger for one formbase subscription event. Every formbase
 * trigger is the same machine: pick a form, subscribe with one `eventType`,
 * receive exactly one event `type`, verify its signature, and offer the
 * envelope (plus, for an event with answers, one output per field key) as
 * outputs. Only the event, the labels, the sample and the extra inputs differ.
 *
 * - `eventType` / `payloadType`: what `webhooks.create` subscribes to and the
 *   `type` of the one event it delivers.
 * - `carriesAnswers`: the event has `data.answers` and `data.display`, so the
 *   form's field list becomes output fields.
 * - `extraInputFields` / `subscribeParams`: inputs beyond the form, and what
 *   they add to `webhooks.create`.
 * - `performList`: the test sample, from the API.
 */
function createHookTrigger({
  key,
  noun,
  label,
  description,
  formHelpText,
  eventType,
  payloadType,
  envelopeOutputFields,
  carriesAnswers,
  extraInputFields = [],
  subscribeParams = () => ({}),
  sample,
  performList,
}) {
  async function outputFields(z, bundle) {
    const formId = bundle.inputData.formId
    if (!carriesAnswers || !formId) return envelopeOutputFields

    const items = await listFields(z, bundle, formId)
    return [...envelopeOutputFields, ...items.flatMap((item) => answerOutputFields(item, 'data__'))]
  }

  async function performSubscribe(z, bundle) {
    return subscribe(z, bundle, { eventType, ...subscribeParams(bundle) })
  }

  /**
   * A subscription only ever receives its own event type, so anything else is
   * a payload this trigger does not understand. Rejecting it keeps a Zap that
   * waits for one event from running on another.
   */
  async function perform(z, bundle) {
    requireVerifiedDelivery(bundle)
    const event = bundle.cleanedRequest
    if (event.type !== payloadType) {
      throw new Error(`formbase delivered a ${event.type} event to a ${payloadType} subscription.`)
    }
    return [addPdfFileHydrator(z, event)]
  }

  async function performListWithPdf(z, bundle) {
    return [addPdfFileHydrator(z, await performList(z, bundle))]
  }

  return {
    key,
    noun,
    display: { label, description },
    operation: {
      type: 'hook',
      cleanInputData: false,
      inputFields: [
        {
          key: 'formId',
          label: 'Form',
          type: 'string',
          required: true,
          dynamic: 'form_list.id.label',
          helpText: formHelpText,
        },
        ...extraInputFields,
      ],
      performSubscribe,
      performUnsubscribe: unsubscribe,
      perform,
      performList: performListWithPdf,
      sample,
      outputFields: [outputFields],
    },
  }
}

module.exports = { createHookTrigger }
