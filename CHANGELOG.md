# Changelog

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
