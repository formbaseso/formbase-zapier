'use strict'

const { formbaseRpc } = require('./request')

const FORMS_PAGE_SIZE = 100
const REQUESTS_PAGE_SIZE = 25

/**
 * The one workspace this connection is scoped to.
 *
 * A formbase OAuth token is scoped to the one workspace the user picked on the
 * consent screen, so `workspaces.list` answers with exactly that workspace.
 */
async function getWorkspace(z, bundle) {
  const { items: workspaces } = await formbaseRpc({ z, bundle, method: 'workspaces.list' })
  const workspace = workspaces[0]
  if (!workspace) throw new Error('This formbase connection has no workspace. Reconnect and pick one.')
  return workspace
}

/**
 * Every form of the connected workspace, for the `form_list.id.label` dynamic
 * dropdown. `forms.list` pages by cursor. An unpublished form is still listed,
 * since a trigger can be wired up before the form goes live, but its label says
 * so: Create Request refuses it.
 */
async function listForms(z, bundle) {
  const workspace = await getWorkspace(z, bundle)

  const forms = []
  let cursor
  do {
    const page = await formbaseRpc({
      z,
      bundle,
      method: 'forms.list',
      params: { workspaceId: workspace.id, limit: FORMS_PAGE_SIZE, ...(cursor ? { cursor } : {}) },
    })
    forms.push(...page.items.map((form) => ({ id: form.id, label: form.isPublished ? form.name : `${form.name} (not published)` })))
    cursor = page.hasMore ? page.nextCursor : null
  } while (cursor)
  return forms
}

/** How a request reads in the dropdown: who it is for, where it stands, and the caller's id for it. */
function requestLabel(request) {
  const recipient = request.recipient.email || request.recipient.name || 'No recipient'
  return [recipient, request.status, request.externalId].filter(Boolean).join(' · ')
}

/**
 * The newest requests, one page per dropdown page, for the
 * `request_list.id.label` dynamic dropdown. Scoped to the action's form when it
 * has one picked, otherwise to the workspace. Zapier asks for the next page
 * with `bundle.meta.page`, and the formbase cursor rides along in `z.cursor`;
 * an empty cursor means the previous page was the last.
 */
async function listRequests(z, bundle) {
  let cursor
  if (bundle.meta?.page) {
    cursor = await z.cursor.get()
    if (!cursor) return []
  }

  const { formId } = bundle.inputData
  const scope = formId ? { formId } : { workspaceId: (await getWorkspace(z, bundle)).id }
  const page = await formbaseRpc({
    z,
    bundle,
    method: 'requests.list',
    params: { ...scope, limit: REQUESTS_PAGE_SIZE, ...(cursor ? { cursor } : {}) },
  })
  await z.cursor.set(page.hasMore ? page.nextCursor : '')
  return page.items.map((request) => ({ id: request.id, label: requestLabel(request) }))
}

module.exports = { getWorkspace, listForms, listRequests }
