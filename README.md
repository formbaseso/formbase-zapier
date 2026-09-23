# formbase Zapier Integration

Native Zapier marketplace app for [formbase](https://formbase.so). formbase collects and verifies information from customers for workflows and AI agents: a Zap or an agent creates a request, the customer completes a branded form without an account, and the verified answers come back keyed by field key. This app creates, finds, reminds and cancels requests from a Zap, and resumes Zaps when a request is completed, expires or is canceled, or when a form is submitted.

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
- **Public-link submission triggers** (`triggers/public_link_submission_created.js`,
  `triggers/public_link_submission_updated.js`,
  `triggers/public_link_submission_abandoned.js`, built by one factory in
  `utils/public_link_submission_trigger.js`) — REST Hooks that subscribe via
  `webhooks.create`, unsubscribe via `webhooks.delete`, and each deliver one
  event type:
  - **Public Link Submission Created** (`public_link_submission_created`) subscribes
    to `submission_created` and receives `submission.completed` for a new
    submission.
  - **Public Link Submission Updated** (`public_link_submission_updated`)
    subscribes to `submission_updated` and receives `submission.updated` when
    the respondent edits a submission they already sent; the form must allow
    editing after submit.
  - **Public Link Submission Abandoned** (`public_link_submission_abandoned`,
    requires partial-submission tracking) subscribes to `submission_abandoned`
    and receives `submission.abandoned`. It has a required idle window: 12
    hours, 1 day, 3 days, or 1 week; formbase sweeps idle drafts hourly, so
    delivery can occur up to one hour after the threshold.
  - A delivery whose `type` is not the one the trigger subscribed to is
    rejected, so a misrouted event never runs the wrong Zap.
  - Every event is the formbase envelope `{ id, type, createdAt, apiVersion,
    test, data }`: `data.answers` holds each answer once under its field key,
    `data.display` the readable text under the same key and `data.submission`
    the email, timestamp, PDF link and language. It fires for public-link
    submissions only: a completed request never reaches it (one channel, one
    event), so no `data.request` block appears here.
  - Output fields are built per form from `fields.list`
    (`data__answers__<key>` and `data__display__<key>`, labelled with the
    question title). A repeating group's members are line items under the
    group key; a matrix gets one field per row. A form that is not published
    yet lists the envelope alone, so a Zap can be wired up before publishing.
  - Samples come from `submissions.sample`, relabelled `submission.updated` or
    `submission.abandoned` for the Updated or Abandoned trigger so filters and
    mapped fields reflect its live payload.
  - The PDF File output hydrates from `submissions.pdf` when the event carries
    `data.submission.pdfUrl`; an event that carries a PDF without the ids to
    hydrate it fails loudly instead of dropping the output.
- **Webhook verification** — each subscription generates a unique signing
  secret, passes it to `webhooks.create`, stores it in Zapier's
  `subscribeData`, and verifies `X-formbase-Signature` against the exact raw
  request body with HMAC-SHA256. Requests with a missing/invalid signature or a
  timestamp more than five minutes old are rejected.
- **Request triggers** (`triggers/request_completed.js`,
  `triggers/request_expired.js`, `triggers/request_canceled.js`, built by one
  factory in `utils/request_trigger.js`) — REST Hooks keyed
  `request_completed`, `request_expired` and `request_canceled`. Each
  subscribes with its own `eventType` and shares subscribe, unsubscribe and
  signature verification with the public-link submission triggers (`utils/webhooks.js`). A
  delivery whose `type` is not the one the Zap subscribed to is rejected, so a
  misrouted event never resumes the wrong Zap. Samples come from
  `requests.sample { formId, eventType }`.
  - Every event carries `data.request`: id, external id, status, outcome,
    recipient, language, metadata, context and the timestamps. **Request
    Completed** also carries the submission block, `data.answers` and
    `data.display`, and lists one output per field key from `fields.list`
    like Public Link Submission Created does. Expired and canceled list the request
    block alone.
  - A completed request fires **Request Completed** alone, never
    **Public Link Submission Created**. A Zap that wants every answer, whichever channel produced
    it, is one Zap on each trigger.
- **Actions** (`creates/`):
  - **Create Request** (`create_request`, `requests.create`) — pick a form,
    and the editor loads one input per prefillable field key (`prefill`),
    one per hidden field marked `context`, and a multi-select of the
    prefilled keys to lock (`readonly`), all built from `fields.list`. A
    repeating group becomes line items and a matrix one input per row. Plain
    inputs cover recipient email and name, language, delivery (`none` or
    `email`), reminders, expiry, external id, metadata and test mode. Zapier
    input keys cannot hold `.` or `-`, so field keys are encoded to `_` in
    the editor and the payload is rebuilt from the live field list on every
    run; two keys that encode the same fail loudly. The external id, when
    set, is also sent as `idempotencyKey`, so a replayed Zap run reuses the
    request instead of creating a second one. The output is the created
    summary with the share link under `url`.
  - **Cancel Request** (`cancel_request`, `requests.cancel`) — request id and
    an optional reason.
  - **Remind Request** (`remind_request`, `requests.remind`) — request id.
  - **Get Request** (`get_request`, `requests.get`) — the request with its
    share link, answers and display under `answers__<key>` and
    `display__<key>`; an optional form picker labels those outputs.
- **Search `find_request`** (`searches/find_request.js`, `requests.list`) —
  by external id, within a form or across the connected workspace, optionally
  including test requests. Returns the matching requests, or nothing.
- **Form picker** (`triggers/form_list.js`, hidden trigger keyed `form_list`) —
  feeds every `formId` dropdown via `form_list.id.name`. An OAuth
  token is scoped to one workspace, so the picker lists that workspace's forms,
  following `forms.list` cursors.
- **JSON-RPC client** (`utils/request.js`) — POSTs to `${BASE_URL}/api/v1` with
  `Authorization: Bearer <access_token>` and unwraps the `{ ok, data, error }`
  envelope. `UNAUTHORIZED` → `RefreshAuthError` (token refresh + retry),
  `RATE_LIMITED` → `ThrottledError`, anything else → `Error("CODE: message")`
  with `error.code` set. There is no `beforeRequest` middleware: the client sets
  its own header, and a middleware would also run on the OAuth token and
  refresh requests.

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
npm test                          # jest: unit tests (nock) + a lifecycle test against an in-process formbase API

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
├── hydrators.js             # lazy PDF File download via submissions.pdf
├── index.js                 # app export
├── triggers/
│   ├── submission.js        # REST Hooks trigger: submission completed / abandoned
│   ├── request_completed.js # REST Hooks trigger: a request is completed
│   ├── request_expired.js   # REST Hooks trigger: a request expires
│   ├── request_canceled.js  # REST Hooks trigger: a request is canceled
│   └── form_list.js         # hidden trigger (key: form_list) for the form picker
├── creates/
│   ├── create_request.js    # requests.create with per-field prefill/context inputs
│   ├── cancel_request.js    # requests.cancel
│   ├── remind_request.js    # requests.remind
│   └── get_request.js       # requests.get
├── searches/
│   └── find_request.js      # requests.list by external id
├── utils/
│   ├── request.js           # JSON-RPC transport + error mapping
│   ├── list_forms.js        # form-picker dropdown source + workspace lookup
│   ├── webhooks.js          # subscribe, unsubscribe, signature verification
│   ├── fields.js            # fields.list and per-key output fields
│   ├── events.js            # envelope output fields, PDF hydrator
│   ├── request_trigger.js   # factory for the three request triggers
│   └── request_summary.js   # request output fields, sample, Request ID input
└── test/
    ├── helpers.js           # z stand-in, signed-delivery bundle
    ├── fake-formbase.js     # in-process formbase API for the lifecycle test
    ├── *.test.js            # unit tests (nock)
    └── lifecycle.integration.test.js
```
