# formbase Zapier Integration

Native Zapier marketplace app for [formbase](https://formbase.so). formbase collects and verifies information from customers for workflows and AI agents: a Zap or an agent creates a request, the customer completes a branded form without an account, and the verified answers come back keyed by field key. This app creates, finds, reminds and cancels requests from a Zap, and resumes Zaps when a request is completed, expires or is canceled, or when a form is submitted.

## What a Zap can do

| Kind    | Name                             | What it does                                                                                                     |
| ------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Trigger | Request Completed                | A recipient completed a request. Answers per field key, the outcome, the submission and its PDF.                 |
| Trigger | Request Expired                  | A request reached its expiry unanswered.                                                                         |
| Trigger | Request Canceled                 | A request was canceled, with the reason.                                                                         |
| Trigger | Public Link Submission Created   | A respondent submitted the form through its public link.                                                         |
| Trigger | Public Link Submission Updated   | A respondent edited a public-link submission they already sent. The form must allow editing after submit.        |
| Trigger | Public Link Submission Abandoned | A public-link draft sat idle for 12 hours, 1 day, 3 days or 1 week. Needs partial-submission tracking.           |
| Action  | Create Request                   | Assign a published form to one recipient, with prefilled, read-only and context fields. Returns the link.        |
| Action  | Get Request                      | Read a request, with its answers once it is completed.                                                           |
| Action  | Remind Request                   | Email the recipient a reminder now.                                                                              |
| Action  | Cancel Request                   | Withdraw a pending request, with an optional reason.                                                             |
| Search  | Find Request                     | Find requests by the External ID a Create Request step gave them.                                                |

Things that make a Zap easier to build:

- **Form** dropdowns list the connected workspace's forms. A form that is not published yet says so: its triggers can be wired up already, but Create Request needs it published.
- **Create Request** loads one input per field of the picked form: a dropdown for a choice question, line items for a repeating group, one input per row for a matrix, and a multi-select of the prefilled fields to lock.
- **Request** inputs (Get, Remind, Cancel) offer a dropdown of the newest requests, labelled by recipient, status and External ID, or an inline **Find Request** step.
- Every trigger and Get Request label their answer outputs with the form's question titles once a form is picked. A booking and a payment answer map property by property (start time, amount, …).
- **External ID** on Create Request is also the idempotency key: a replayed Zap run gets the same request back (`deduplicated: true`) instead of sending the recipient a second link.

formbase posts every event once, to one trigger: a completed request fires **Request Completed** alone, never Public Link Submission Created. A Zap that wants every answer, whichever channel produced it, is one Zap on each trigger.

## How it works

This repository is a self-contained CommonJS project with its own `node_modules`
and `package-lock.json`, as required by the Zapier CLI.

- **Auth** (`authentication.js`) — OAuth 2.0 authorization code + **PKCE (S256,
  mandatory)**. Users click Connect, sign in, pick a workspace on the consent
  screen, approve — no API token to paste. Backed by
  `packages/convex/src/http/oauthServer/`.
  - Scope `api:read api:write offline_access` (`offline_access` → rotating
    refresh token; access 1h, refresh 30d).
  - `test` calls `me.get` (`{ id, email, name }`) so the label renders `{{email}}`.
  - Env vars: `CLIENT_ID`, `CLIENT_SECRET` (see setup below), optional `BASE_URL`
    (default `https://api.formbase.so`).
- **Triggers** — six REST hooks built by one factory, `utils/hook_trigger.js`.
  Each picks a form, subscribes with one `webhooks.create` `eventType`,
  unsubscribes with `webhooks.delete`, and accepts exactly one event `type`; a
  delivery of any other type is rejected, so a misrouted event never runs the
  wrong Zap. `utils/request_trigger.js` and
  `utils/public_link_submission_trigger.js` hold what differs: the event, the
  labels, the sample, and the idle window of the abandoned trigger.

  | Trigger key                        | `eventType`            | Delivered `type`       | Test sample                     |
  | ---------------------------------- | ---------------------- | ---------------------- | ------------------------------- |
  | `request_completed`                | `request_completed`    | `request.completed`    | `requests.sample`               |
  | `request_expired`                  | `request_expired`      | `request.expired`      | `requests.sample`               |
  | `request_canceled`                 | `request_canceled`     | `request.canceled`     | `requests.sample`               |
  | `public_link_submission_created`   | `submission_created`   | `submission.completed` | `submissions.sample`            |
  | `public_link_submission_updated`   | `submission_updated`   | `submission.updated`   | `submissions.sample`, relabeled |
  | `public_link_submission_abandoned` | `submission_abandoned` | `submission.abandoned` | `submissions.sample`, relabeled |

  - Every event is the formbase envelope `{ id, type, createdAt, apiVersion,
    test, data }`. `data.answers` holds each answer once under its field key,
    `data.display` the readable text under the same key, and `data.submission`
    the email, timestamps, edit count, PDF link and language. A request event
    adds `data.request`; an expired or canceled request carries that block
    alone.
  - Output fields are built per form from `fields.list`
    (`data__answers__<key>` and `data__display__<key>`, labelled with the
    question title). A repeating group's members are line items under the
    group key, a matrix gets one field per row, and a booking or a payment one
    field per property. A form that is not published yet lists the envelope
    alone, so a Zap can be wired up before publishing.
  - The PDF File output hydrates from `submissions.pdf` when the event carries
    `data.submission.pdfUrl`; an event that carries a PDF without the ids to
    hydrate it fails loudly instead of dropping the output.
- **Webhook verification** (`utils/webhooks.js`) — each subscription generates
  a unique signing secret, passes it to `webhooks.create`, stores it in
  Zapier's `subscribeData`, and verifies `X-formbase-Signature` against the
  exact raw request body with HMAC-SHA256. Requests with a missing or invalid
  signature, or a timestamp more than five minutes old, are rejected.
- **Create Request** (`creates/create_request.js`, `requests.create`) — the
  per-field inputs come from `fields.list` (`prefill` for visible questions,
  `context` for hidden fields, `readonly` for the prefilled keys to lock).
  Zapier input keys cannot hold `.` or `-`, so field keys are encoded to `_`
  in the editor and the payload is rebuilt from the live field list on every
  run; two keys that encode the same fail loudly. The output is the created
  summary with the share link under `url`.
- **Get, Remind, Cancel** (`creates/`) and **Find Request**
  (`searches/find_request.js`, `requests.list` by external id, within a form
  or across the workspace) share the request summary outputs in
  `utils/request_summary.js`. Timestamps of a request summary are Unix
  milliseconds; event timestamps are ISO 8601.
- **Dropdowns** (`utils/dropdowns.js`) — hidden triggers `form_list`
  (`form_list.id.label`, every page of `forms.list`) and `request_list`
  (`request_list.id.label`, `requests.list` one page per dropdown page, the
  formbase cursor kept in `z.cursor`). An OAuth token is scoped to one
  workspace, so both list that workspace.
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
npm run validate                  # Zapier's structural schema check, offline (CI runs it too)

npx zapier-platform login --sso         # one-time
npx zapier-platform register "formbase"   # one-time; creates .zapierapprc
npx zapier-platform validate            # adds Zapier's online style checks
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
│   ├── request_completed.js / request_expired.js / request_canceled.js
│   ├── public_link_submission_created.js / _updated.js / _abandoned.js
│   ├── form_list.js         # hidden: Form dropdown
│   └── request_list.js      # hidden: Request dropdown
├── creates/
│   ├── create_request.js    # requests.create with per-field prefill/context inputs
│   ├── get_request.js       # requests.get
│   ├── remind_request.js    # requests.remind
│   └── cancel_request.js    # requests.cancel
├── searches/
│   └── find_request.js      # requests.list by external id
├── utils/
│   ├── hook_trigger.js      # the one REST hook trigger factory
│   ├── request_trigger.js   # request events: event types, samples
│   ├── public_link_submission_trigger.js  # submission events: event types, samples, idle window
│   ├── samples.js           # sample envelope, submission, booking and payment
│   ├── events.js            # envelope output fields, PDF hydrator
│   ├── fields.js            # fields.list, per-key output fields, field type map
│   ├── webhooks.js          # subscribe, unsubscribe, signature verification
│   ├── dropdowns.js         # workspace lookup, form and request dropdown sources
│   ├── request_summary.js   # request output fields, sample, Request input
│   └── request.js           # JSON-RPC transport + error mapping
└── test/
    ├── helpers.js           # z stand-in, signed-delivery bundle
    ├── fake-formbase.js     # in-process formbase API for the lifecycle test
    ├── *.test.js            # unit tests (nock)
    └── lifecycle.integration.test.js
```
