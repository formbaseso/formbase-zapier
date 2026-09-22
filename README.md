# formbase Zapier Integration

Native Zapier marketplace app for [formbase](https://formbase.so).

This repository is a self-contained CommonJS project with its own `node_modules`
and `package-lock.json`, as required by the Zapier CLI.

## What it ships

- **Auth** (`authentication.js`) — OAuth 2.0 authorization code + **PKCE (S256,
  mandatory)**. Users click Connect, sign in, pick a workspace on the consent
  screen, approve — no API token to paste. Backed by
  `packages/convex/src/http/oauthServer/`.
  - Scope `api:read api:write offline_access` (`offline_access` → rotating
    refresh token; access 1h, refresh 30d).
  - `test` calls `me.get` (`{ id, email, name }`) so the label renders `{{email}}`.
  - Env vars: `CLIENT_ID`, `CLIENT_SECRET` (see setup below), optional `BASE_URL`
    (default `https://api.formbase.so`).
- **Trigger `submission`** (REST Hooks) — subscribes via `webhooks.create`
  (returns `{ subscriptionId, … }`), unsubscribes via `webhooks.delete`
  (`subscriptionId`), and supports `submission_created` plus
  `submission_abandoned` (requires partial-submission tracking). Abandoned Zaps
  choose a required idle window: 12 hours, 1 day, 3 days, or 1 week. formbase
  checks idle drafts hourly, so delivery can occur up to one hour after the
  selected threshold. Completed-submission subscriptions receive both new
  (`submission.completed`) and later edited (`submission.updated`) events; no
  separate updated-submission trigger is needed. Abandoned-submission
  subscriptions receive `submission.abandoned`. Samples come from
  `submissions.sample`; Zapier labels an abandoned trigger's sample
  `submission.abandoned` so filters and mapped fields reflect its live payload.
  Every event is the formbase envelope `{ id, type, createdAt, apiVersion, test,
  data }`: `data.answers` holds each answer once under its field key,
  `data.display` the readable text under the same key, and
  `data.submission.language` the BCP-47 language. Output fields are built per
  form from `fields.list` (`data__answers__<key>`, `data__display__<key>`; a
  repeating group's members are line items under the group key), so the Zap
  editor shows real question titles.
- **Webhook verification** — each REST Hook subscription generates a unique
  signing secret, passes it to `webhooks.create`, stores it in Zapier's
  `subscribeData`, and verifies `X-formbase-Signature` against the exact raw
  request body with HMAC-SHA256. Requests with a missing/invalid signature or a
  timestamp more than five minutes old are rejected.
- **Form picker** (`triggers/form_list.js`, hidden trigger keyed `form_list`) —
  feeds the `submission` `formId` dropdown via `form_list.id.name`.
- **JSON-RPC client** (`utils/request.js`, `utils/list_forms.js`) — POSTs to
  `${BASE_URL}/api/v1` with `Authorization: Bearer <access_token>`, parses the
  `{ ok, data, error }` envelope; `workspaces.list`/`forms.list` return
  `{ items, hasMore }`. Error mapping: `UNAUTHORIZED` → `RefreshAuthError`
  (triggers token refresh + retry), `RATE_LIMITED` → `ThrottledError`, else
  `Error("CODE: message")`.

### Auth-config gotchas (don't regress these)

Zapier injects standard OAuth fields itself; declaring them manually breaks the
flow:

- **`authorizeUrl.params`** declares **only `scope`**. Zapier auto-appends
  `client_id`, `state`, `redirect_uri`, `response_type`, `code_challenge`,
  `code_challenge_method`. Declaring `client_id` lands it first as an empty value
  and shadows Zapier's → `Missing required parameter: client_id`.
- **`getAccessToken.body` lists every field, including `code_verifier`.** Unlike
  `authorizeUrl`, Zapier does **not** merge into the token body — it sends exactly
  what we define. Omit `grant_type` → `grant_type <missing>`; omit `code_verifier`
  → `code, redirect_uri, and code_verifier are required`. `enablePkce` exposes the
  verifier as `{{bundle.inputData.code_verifier}}`; client creds go in the body
  (`client_secret_post`).
- `refreshAccessToken` keeps its own explicit body (refresh needs no PKCE).

## OAuth client setup (`oauthClients` table)

Zapier needs a **fixed** `client_id`/`secret` baked into its env, so it uses a
first-party **system client** seeded directly into the `oauthClients` table — not
public Dynamic Client Registration (DCR ids are random per env and the
orphan-client GC reaps them after 30d once token-less).

`internal/oauthClients.ts:seedZapierOAuthClient` inserts a row with `createdByIp`
unset (→ GC-protected) and `tokenEndpointAuthMethod: 'client_secret_post'`. The
secret is read from the `ZAPIER_OAUTH_CLIENT_SECRET` Convex env var (never a CLI
arg) and stored hashed; you set the **same** plaintext on Zapier.

The `redirectUris` must exactly match the Zapier callback shown in the dashboard
(**Settings → Authentication**) — currently
`https://zapier.com/dashboard/auth/oauth/return/App242862CLIAPI/`. A mismatch →
`redirect_uri not registered for this client`. Verify the app id before seeding.

```bash
# Run against BOTH prod and dev (same secret) so the Zap works in both.
# 1. Set the secret on the formbase deployment (add --prod for production).
npx convex env set ZAPIER_OAUTH_CLIENT_SECRET 'pick_a_long_random_secret'

# 2. Seed the client — idempotent; re-run to update redirectUris / rotate secret.
npx convex run internal/oauthClients:seedZapierOAuthClient \
  '{"redirectUris":["https://zapier.com/dashboard/auth/oauth/return/App242862CLIAPI/"]}'
# → { "clientId": "fboc_zapier", "created": true }

# 3. Mirror onto the Zapier app version (injected as process.env.*). Secret MUST
#    equal step 1's value.
npx zapier-platform env:set 1.0.0 \
  CLIENT_ID=fboc_zapier \
  CLIENT_SECRET='pick_a_long_random_secret' \
  BASE_URL=https://api.formbase.so
```

`client_id` defaults to `fboc_zapier` (override with a `clientId` arg). This is a
separate row from public DCR clients (e.g. Claude MCP), so it never interferes
with them — the server authenticates each client by its stored auth method.

## Develop, validate, publish

```bash
cd formbase-zapier
npm install
npm test                          # jest + nock, no credentials needed

npx zapier-platform login --sso         # one-time
npx zapier-platform register "formbase"   # one-time; creates .zapierapprc
npx zapier-platform validate
npx zapier-platform push
npx zapier-platform promote 1.0.0
```

After pushing this change, turn every existing formbase Zap off and back on (or
recreate its trigger). This registers a new subscription containing the required
idle window and signing secret. Old subscriptions are intentionally unsupported.

> CLI bin is `zapier-platform` (was `zapier`) since `zapier-platform-cli` v19.
> `validate` needs the app registered first (expects `.zapierapprc`).

For **marketplace submission**: fill App Details (logo, description, categories),
provide demo credentials (a login bound to a demo workspace with a form), submit
for Public review (~1–3 weeks).

## Reference

- [Formbase API methods](https://docs.formbase.so/developers/rest-api)
- [Formbase webhook reference](https://docs.formbase.so/developers/webhooks-reference)

## File map

```
formbase-zapier/
├── authentication.js        # OAuth 2.0 (auth code + PKCE)
├── index.js                 # app export, Bearer-injecting beforeRequest hook
├── triggers/
│   ├── submission.js        # REST Hooks trigger
│   └── form_list.js         # hidden trigger (key: form_list) for the form picker
├── utils/
│   ├── request.js           # JSON-RPC transport + error mapping
│   └── list_forms.js        # form-picker dropdown source
└── test/                    # jest + nock unit tests
```
