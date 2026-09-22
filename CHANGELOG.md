# Changelog

## 1.1.0

- Update trigger/submission: read the formbase event envelope (`id`, `type`, `createdAt`, `apiVersion`, `test`, `data`) that replaced the flat payload; `fields[]` is gone and every answer arrives once in `data.answers` with its readable text in `data.display`.
- Update trigger/submission: build output fields per form from `fields.list`, so mapped fields carry the question's title and key instead of a generic `fields[]` line item.
- Update trigger/submission: the PDF file hydrates from `data.submission.pdfUrl` (was `submission.submissionPdfLink`), and an event that carries a PDF without the ids to hydrate it now fails loudly instead of dropping the PDF File output.
- Fix trigger/submission: output fields fall back to the envelope when `fields.list` rejects an unpublished form, so a Zap can still be wired up before the form is published.

## 1.0.0

- Update trigger/submission: support completed and abandoned submission events with selectable idle windows.
- Fix trigger/submission: expose abandoned deliveries as `ABANDON_RESPONSE` in live payloads and test samples.
- Update trigger/submission: verify signed formbase webhook deliveries and expose submission language, PDFs, and repeating-group values.
