# Changelog

## 4.2.0

- Update every submission and request trigger and Get Request: a Schedule appointment answer and a Payment answer each map property by property. A booking gives Status, Start, End, Time Zone, Attendee Name, Attendee Email, Meeting URL, Event Title, Provider and Provider Booking ID; a payment gives Status, Amount, Currency, Amount Refunded, Receipt URL, Paid At, Refunded At, Disputed At, Provider and Provider Payment Intent ID. The `(display)` field keeps one line of text for each. The samples carry both.
- Behaviour change from formbase (event `apiVersion` `2026-09-24`), not from this version: a booking answer is an object, not a sentence. A Zap that mapped the booking answer itself now receives an object; map one of its properties, or the booking's `(display)` field for the old sentence. A Payment question used to have no answer; it now has one.

## 4.1.0

- Update every submission and request trigger: add Last Edited At (`data.submission.updatedAt`) and Edit Count (`data.submission.editCount`), so a Zap can tell a fresh submission from one the respondent changed afterwards. Last Edited At is empty until the first edit; Edit Count starts at 0. The samples carry both fields.

## 4.0.0

- Breaking: remove trigger/public_link_submission and add trigger/public_link_submission_created: Public Link Submission Created under the key that matches its label and its Updated and Abandoned siblings. Behaviour is unchanged. Zaps built on `public_link_submission` do not migrate; rebuild them on Public Link Submission Created. No 3.0.0 Zap exists, so nothing needs rebuilding.

## 3.0.0

- Breaking: replace the Event field of Public Link Submission with one trigger per event. Triggers show up in Zapier's trigger picker, where an option inside a dropdown does not, and each trigger now carries only the inputs its event needs.
  - Update trigger/public_link_submission: renamed Public Link Submission Created. It fires for new submissions only (`submission.completed`) and has no Event field.
  - Add trigger/public_link_submission_updated (Public Link Submission Updated): fires when a respondent edits a submission they already sent through the public link (`submission.updated`). The form must allow editing after submit.
  - Add trigger/public_link_submission_abandoned (Public Link Submission Abandoned): fires when a public-link draft sits idle past its window (`submission.abandoned`). The idle window is a required field of this trigger.
  - Each trigger rejects a delivery of another event type, like the request triggers do.
  - Update trigger/request_completed: the Form help text names Public Link Submission Created.
- Migration: a Zap that set Event to Submission updated or Submission abandoned moves to the matching trigger. A Zap on Submission created keeps working as Public Link Submission Created. No 2.x version has live Zaps, so nothing is migrated automatically.

## 2.1.0

- Update trigger/public_link_submission: add the Submission updated event. It fires when a respondent edits a submission they already sent through the public link (the form must allow editing after submit), and its test sample carries `type: submission.updated`.
- Behaviour change: a Zap on Submission created no longer runs when a respondent edits a submission. It receives new submissions only (`submission.completed`). To act on edits, add a Zap on Submission updated.

## 2.0.1

- Update trigger/public_link_submission: the description says it also fires when a respondent updates a submission; shorter Form and Event help.
- Update trigger/request_completed, trigger/request_expired, trigger/request_canceled: shorter descriptions and help.

## 2.0.0

- Remove trigger/submission and add trigger/public_link_submission: the same trigger under the key that matches its label. Zaps built on `submission` do not migrate; rebuild them on Public Link Submission. Zapier requires a major version for a removed trigger.

## 1.3.1

- Update trigger/submission: renamed to Public Link Submission, so the trigger list says which channel it covers.
- Update trigger/request_completed: the description says it is the only event a completed request fires.

## 1.3.0

- Update trigger/submission: fire for share-link submissions only. A completed request no longer fires the Submission trigger (formbase ADR 0030, one channel, one event), so a Zap on Submission and a Zap on Request Completed run one each per completion and the Filter on Request ID is no longer needed. The Request ID and Request External ID outputs are gone from the Submission trigger, since no event it receives can carry them; a Zap that wants every answer, whichever channel produced it, is one Zap on each trigger.
- Update trigger/request_completed: the Form help text no longer warns about a second event on the Submission trigger.

## 1.2.0

- Add create/create_request: create a request for a form. The editor loads one input per prefillable field key, one per hidden field marked as context, and a multi-select of the prefilled keys to lock, all from `fields.list`; recipient, language, delivery, reminders, expiry, external id, metadata and test mode are plain inputs. The external id doubles as the idempotency key, so a replayed Zap run reuses the request. The output carries the share link.
- Add create/cancel_request, create/remind_request and create/get_request: cancel a request with an optional reason, send a reminder, and read a request back with its answers and display keyed by field key.
- Add search/find_request: find requests by external id within a form or across the connected workspace, optionally including test requests.
- Add trigger/request_completed, trigger/request_expired and trigger/request_canceled: REST Hooks that fire when a request is completed, expires or is canceled. Each subscribes with its own event type, rejects a delivery of another type, and tests against `requests.sample`. Request Completed also carries the submission, answers and display; the other two carry the request block alone.
- Update trigger/submission: keep firing for a completed request, and say in the Form help text that a Zap which should react only to requests uses Request Completed. Subscribe, unsubscribe, signature verification, output-field building and the PDF hydrator now live in `utils/` and are shared with the request triggers.

## 1.1.1

- Update trigger/submission: describe the trigger in terms of requests. It fires when a customer completes a request or submits a form, and the Form help text says a request created for the form carries Request ID and Request External ID.

## 1.1.0

- Update trigger/submission: read the formbase event envelope (`id`, `type`, `createdAt`, `apiVersion`, `test`, `data`) that replaced the flat payload; `fields[]` is gone and every answer arrives once in `data.answers` with its readable text in `data.display`.
- Update trigger/submission: build output fields per form from `fields.list`, so mapped fields carry the question's title and key instead of a generic `fields[]` line item. A matrix gets one field per row, and the request a submission answered is offered as Request ID / Request External ID.
- Update trigger/submission: the PDF file hydrates from `data.submission.pdfUrl` (was `submission.submissionPdfLink`), and an event that carries a PDF without the ids to hydrate it now fails loudly instead of dropping the PDF File output.
- Update trigger/submission: an unpublished form lists the envelope outputs alone (`fields.list` answers `published: false`), so a Zap can be wired up before the form is published; any other `fields.list` failure surfaces instead of hiding the answer fields.
- Update trigger/form_list: list the connected workspace's forms across every `forms.list` page. An OAuth token is scoped to one workspace, so the workspace prefix is gone.
- Update app: drop the `beforeRequest` Bearer middleware, which also ran on the OAuth token and refresh requests; the JSON-RPC client sets its own header.

## 1.0.0

- Update trigger/submission: support completed and abandoned submission events with selectable idle windows.
- Fix trigger/submission: expose abandoned deliveries as `ABANDON_RESPONSE` in live payloads and test samples.
- Update trigger/submission: verify signed formbase webhook deliveries and expose submission language, PDFs, and repeating-group values.
