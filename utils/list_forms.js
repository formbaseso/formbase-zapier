'use strict';

const { formbaseRpc } = require('./request');

/**
 * Fetch the user's forms via JSON-RPC and shape them for a Zapier dynamic
 * dropdown — the dropdown reference `form_list.id.name` expects each
 * row to expose `id` and `name` keys.
 *
 * `forms.list` requires a `workspaceId`, so we first pull all workspaces the
 * user belongs to and fan out one call per workspace.
 *
 * Both `workspaces.list` and `forms.list` return a paginated `{ items, hasMore }`
 * envelope (after the JSON-RPC `{ ok, data }` strip).
 */
async function listForms(z, bundle) {
  const workspacesResult = await formbaseRpc({ z, bundle, method: 'workspaces.list', params: {} });
  const workspaces = workspacesResult?.items ?? [];

  const all = [];
  for (const ws of workspaces) {
    const page = await formbaseRpc({
      z,
      bundle,
      method: 'forms.list',
      params: { workspaceId: ws.id, limit: 100 },
    });
    for (const f of page.items) {
      all.push({
        id: f.id,
        name: workspaces.length > 1 ? `${ws.name} / ${f.name}` : f.name,
      });
    }
  }
  return all;
}

module.exports = { listForms };
