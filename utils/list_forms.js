'use strict'

const { formbaseRpc } = require('./request')

const FORMS_PAGE_SIZE = 100

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
 * Every form of the connected workspace, shaped for the `form_list.id.name`
 * dynamic dropdown. The dropdown needs no workspace prefix (see getWorkspace).
 * `forms.list` pages by cursor.
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
    forms.push(...page.items.map((form) => ({ id: form.id, name: form.name })))
    cursor = page.hasMore ? page.nextCursor : null
  } while (cursor)
  return forms
}

module.exports = { listForms, getWorkspace }
