'use strict'

// The pieces every sample event is built from, so the submission and request
// samples cannot drift apart (docs/external-api.md § Events).

const SAMPLE_PDF_URL = 'https://api.formbase.so/api/storage/00000000-0000-4000-8000-000000000000'

function sampleEnvelope(type, data) {
  return {
    id: 'evt_example000000000000',
    type,
    createdAt: '2026-04-26T12:34:56.000Z',
    apiVersion: '2026-09-24',
    test: false,
    data,
  }
}

/** `data.submission`, with the PDF File output this app adds (see addPdfFileHydrator). */
function sampleSubmission(respondentEmail) {
  return {
    id: 'sub_xyz789',
    respondentEmail,
    submittedAt: '2026-04-26T12:34:56.000Z',
    // Null until the respondent edits the submission after submitting.
    updatedAt: null,
    editCount: 0,
    pdfUrl: SAMPLE_PDF_URL,
    pdfFile: SAMPLE_PDF_URL,
    // BCP-47 language the respondent submitted in (translated forms); null otherwise.
    language: 'en',
  }
}

/**
 * A booking and a payment answer, which arrive as objects; `display` keeps one
 * line of text for each.
 */
function sampleBookingAndPayment(attendee) {
  return {
    answers: {
      book_a_call: {
        status: 'confirmed',
        start: '2026-04-29T07:00:00.000Z',
        end: '2026-04-29T07:30:00.000Z',
        timeZone: 'Europe/Oslo',
        attendee,
        meetingUrl: 'https://app.cal.com/video/example',
        provider: 'cal.com',
        providerBookingId: 'booking_abc123',
        eventTitle: 'Intro call',
      },
      pay_the_fee: {
        status: 'paid',
        amount: 40,
        currency: 'USD',
        amountRefunded: 0,
        receiptUrl: 'https://pay.stripe.com/receipts/example',
        paidAt: '2026-04-26T12:30:00.000Z',
        refundedAt: null,
        disputedAt: null,
        provider: 'stripe',
        providerPaymentIntentId: 'pi_abc123',
      },
    },
    display: {
      book_a_call: `Intro call · Apr 29, 2026, 9:00 AM - 9:30 AM (Europe/Oslo) · ${attendee.name} <${attendee.email}> · https://app.cal.com/video/example`,
      pay_the_fee: '$40.00 USD · Paid',
    },
  }
}

module.exports = { sampleEnvelope, sampleSubmission, sampleBookingAndPayment }
