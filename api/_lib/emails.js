"use strict";

// E-mail templates. Customer e-mails keep the look of the original MRKLL
// booking e-mail (black card, red MRKLL STUDIOS heading). Every template
// returns { subject, html, text }. All dynamic values are HTML-escaped.

const LOCATION = "MRKLL Studios · Barcelona";
const MOTTO = "Where Frequencies Become Reality.";

function escapeHtml(value) {
  return String(value === undefined || value === null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Subjects are plain text: strip line breaks to prevent header injection.
function oneLine(value) {
  return String(value === undefined || value === null ? "" : value).replace(/[\r\n]+/g, " ").trim();
}

function money(cents, currency = "eur") {
  if (cents === null || cents === undefined) return "—";
  return new Intl.NumberFormat("en-GB", { style: "currency", currency: String(currency).toUpperCase() }).format(Number(cents) / 100);
}

function parts(instant, timeZone) {
  const p = new Intl.DateTimeFormat("en-GB", {
    timeZone, weekday: "long", day: "numeric", month: "long", year: "numeric",
  }).formatToParts(new Date(instant));
  const get = (type) => p.find((x) => x.type === type).value;
  return { weekday: get("weekday"), day: get("day"), month: get("month"), year: get("year") };
}

function longDate(instant, timeZone) {
  const p = parts(instant, timeZone);
  return `${p.weekday} ${p.day} ${p.month} ${p.year}`;
}

function shortDate(instant, timeZone) {
  const p = parts(instant, timeZone);
  return `${p.weekday.slice(0, 3)} ${p.day} ${p.month.slice(0, 3)}`;
}

function clock(instant, timeZone) {
  return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(instant));
}

function hours(minutes) {
  const h = Number(minutes) / 60;
  return `${h} ${h === 1 ? "Hour" : "Hours"}`;
}

// Normalised view of a booking (row from get_booking_details).
function describe(b) {
  const tz = b.timezone || "Europe/Madrid";
  return {
    reference: b.reference,
    name: b.customer_name || "MRKLL Client",
    session: b.package_name,
    date: longDate(b.starts_at, tz),
    short: shortDate(b.starts_at, tz),
    time: `${clock(b.starts_at, tz)} – ${clock(b.ends_at, tz)}`,
    duration: hours(b.duration_minutes),
    paid: money(b.amount_paid_cents !== null && b.amount_paid_cents !== undefined ? b.amount_paid_cents : b.price_cents, b.currency),
    price: money(b.price_cents, b.currency),
  };
}

function customerLayout(title, intro, rows, outro) {
  const rowHtml = rows
    .map(([label, value]) => `<p style="margin:0 0 14px;"><strong>${escapeHtml(label)}</strong><br>${escapeHtml(value)}</p>`)
    .join("");
  const html = `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;background:#111;color:#fff;padding:40px;">
  <h1 style="color:#e00000;margin:0 0 8px;">MRKLL STUDIOS</h1>
  <h2 style="margin:0 0 24px;">${escapeHtml(title)}</h2>
  ${intro.map((p) => `<p>${escapeHtml(p)}</p>`).join("")}
  <div style="margin:30px 0;padding:20px;background:#1c1c1c;">${rowHtml}</div>
  ${outro.map((p) => `<p>${escapeHtml(p)}</p>`).join("")}
  <p style="color:#aaa;">${escapeHtml(MOTTO)}</p>
</div>`.trim();
  const text = [
    "MRKLL STUDIOS",
    title,
    "",
    ...intro,
    "",
    ...rows.map(([label, value]) => `${label}: ${value}`),
    "",
    ...outro,
    "",
    MOTTO,
  ].join("\n");
  return { html, text };
}

function studioLayout(title, rows, note) {
  const html = `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;">
  <h1>${escapeHtml(title)}</h1>
  ${note ? `<p><strong>${escapeHtml(note)}</strong></p>` : ""}
  <hr>
  ${rows.map(([label, value]) => `<p><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</p>`).join("\n  ")}
</div>`.trim();
  const text = [title, note || "", "", ...rows.map(([label, value]) => `${label}: ${value}`)].join("\n");
  return { html, text };
}

function studioRows(b) {
  const d = describe(b);
  return [
    ["Reference", d.reference],
    ["Customer", b.customer_name || "—"],
    ["Email", b.customer_email || "—"],
    ["Phone", b.customer_phone || "—"],
    ["Package", d.session],
    ["Date", d.date],
    ["Time (Barcelona)", d.time],
    ["Duration", d.duration],
    ["Amount paid", d.paid],
    ["Stripe session", b.stripe_checkout_session_id || "—"],
    ["Payment intent", b.stripe_payment_intent_id || "—"],
  ];
}

const templates = {
  customer_confirmation(b) {
    const d = describe(b);
    return {
      subject: oneLine(`MRKLL Studios — Booking confirmed (${d.reference})`),
      ...customerLayout(
        "Booking confirmed",
        [`Hi ${d.name},`, "Your studio session has been successfully confirmed and paid."],
        [
          ["Reference", d.reference],
          ["Session", d.session],
          ["Date", d.date],
          ["Time (Barcelona time)", d.time],
          ["Duration", d.duration],
          ["Location", LOCATION],
          ["Amount paid", d.paid],
        ],
        ["Thank you for booking with MRKLL Studios.", "Need to change something? Simply reply to this e-mail and quote your reference."]
      ),
    };
  },

  studio_confirmation(b) {
    const d = describe(b);
    return {
      subject: oneLine(`New Booking — ${d.session} — ${d.short} ${clock(b.starts_at, b.timezone || "Europe/Madrid")} (${d.reference})`),
      ...studioLayout("New MRKLL Studio Booking", studioRows(b)),
    };
  },

  studio_needs_review(b) {
    const d = describe(b);
    return {
      subject: oneLine(`ACTION NEEDED — payment to review (${d.reference})`),
      ...studioLayout("Payment to review", [...studioRows(b), ["Expected amount", d.price]],
        "The amount paid does not match the booking price. The slot is kept; please check the payment in Stripe."),
    };
  },

  customer_conflict(b) {
    const d = describe(b);
    return {
      subject: oneLine(`MRKLL Studios — Your payment has been refunded (${d.reference})`),
      ...customerLayout(
        "We're sorry — this time is no longer available",
        [`Hi ${d.name},`, "Your payment arrived after the reservation time had expired, and in the meantime this session was booked by someone else.", "We have refunded the full amount. Depending on your bank it can take 5–10 days to appear."],
        [
          ["Reference", d.reference],
          ["Session", d.session],
          ["Date", d.date],
          ["Time (Barcelona time)", d.time],
          ["Refunded", d.paid],
        ],
        ["Reply to this e-mail and we will gladly help you find another time."]
      ),
    };
  },

  studio_conflict(b) {
    return {
      subject: oneLine(`Payment conflict — automatic refund issued (${b.reference})`),
      ...studioLayout("Payment conflict", studioRows(b),
        "A payment arrived after its hold had expired and the slot was taken. A full refund has been issued automatically."),
    };
  },

  customer_refund(b) {
    const d = describe(b);
    return {
      subject: oneLine(`MRKLL Studios — Booking cancelled and refunded (${d.reference})`),
      ...customerLayout(
        "Booking cancelled",
        [`Hi ${d.name},`, "Your booking has been cancelled and the payment has been refunded in full. Depending on your bank it can take 5–10 days to appear."],
        [
          ["Reference", d.reference],
          ["Session", d.session],
          ["Date", d.date],
          ["Time (Barcelona time)", d.time],
          ["Refunded", d.paid],
        ],
        ["If you have any question, simply reply to this e-mail."]
      ),
    };
  },

  studio_refund(b) {
    return {
      subject: oneLine(`Booking refunded — slot released (${b.reference})`),
      ...studioLayout("Booking refunded", studioRows(b), "The payment was fully refunded. The slot is available again."),
    };
  },

  // Payment received but it cannot be matched to a booking.
  studio_alert({ title, details }) {
    return {
      subject: oneLine(`ACTION NEEDED — ${title}`),
      ...studioLayout(title, details, "Please check this payment in the Stripe dashboard."),
    };
  },

  // Sessions created before the booking system (metadata packageType/date/time).
  legacy_customer({ name, packageName, duration, date, time, price }) {
    return {
      subject: "MRKLL Studios — Booking Confirmed",
      ...customerLayout(
        "Booking confirmed",
        [`Hi ${name || "MRKLL Client"},`, "Your studio session has been successfully confirmed and paid."],
        [["Session", packageName], ["Duration", duration], ["Date", date], ["Time", time], ["Amount paid", price]],
        ["Thank you for booking with MRKLL Studios."]
      ),
    };
  },

  legacy_studio({ name, email, packageName, duration, date, time, price, sessionId }) {
    return {
      subject: oneLine(`New Booking — ${packageName}`),
      ...studioLayout("New MRKLL Studio Booking", [
        ["Customer", name || "MRKLL Client"], ["Email", email || "—"], ["Package", packageName], ["Duration", duration],
        ["Date", date], ["Time", time], ["Amount", price], ["Stripe Session", sessionId],
      ]),
    };
  },
};

module.exports = { templates, escapeHtml, money, longDate, clock, describe };
