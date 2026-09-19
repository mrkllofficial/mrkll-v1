const Stripe = require("stripe");
const https = require("https");

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

module.exports.config = {
  api: {
    bodyParser: false,
  },
};

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    req.on("data", (chunk) => {
      chunks.push(chunk);
    });

    req.on("end", () => {
      resolve(Buffer.concat(chunks));
    });

    req.on("error", reject);
  });
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function sendBrevoEmail({ to, toName, subject, htmlContent }) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      sender: {
        name: "MRKLL Studios",
        email: "studios@mrkll.com",
      },
      to: [
        {
          email: to,
          name: toName || "",
        },
      ],
      subject,
      htmlContent,
    });

    const request = https.request(
      {
        hostname: "api.brevo.com",
        path: "/v3/smtp/email",
        method: "POST",
        headers: {
          "api-key": process.env.BREVO_API_KEY,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (response) => {
        let body = "";

        response.on("data", (chunk) => {
          body += chunk;
        });

        response.on("end", () => {
          if (response.statusCode >= 200 && response.statusCode < 300) {
            resolve(body);
          } else {
            reject(
              new Error(
                `Brevo API error ${response.statusCode}: ${body}`
              )
            );
          }
        });
      }
    );

    request.on("error", reject);
    request.write(data);
    request.end();
  });
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const signature = req.headers["stripe-signature"];

  if (!signature) {
    return res.status(400).json({ error: "Missing Stripe signature" });
  }

  let event;

  try {
    const rawBody = await getRawBody(req);

    event = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (error) {
    console.error("Stripe webhook verification failed:", error.message);
    return res.status(400).json({ error: "Invalid webhook signature" });
  }

  console.log("Stripe event received:", event.type);

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;

    if (session.payment_status !== "paid") {
      return res.status(200).json({ received: true });
    }

    const packageType = session.metadata?.packageType || "pro";
    const bookingDate = session.metadata?.date || "";
    const bookingTime = session.metadata?.time || "";

    const customerEmail = session.customer_details?.email;
    const customerName =
      session.customer_details?.name || "MRKLL Client";

    const packages = {
      starter: {
        name: "Recording Starter",
        duration: "2 Hours",
        price: "€120",
      },
      legend: {
        name: "Recording Legend",
        duration: "6 Hours",
        price: "€280",
      },
      pro: {
        name: "Recording Pro",
        duration: "4 Hours",
        price: "€200",
      },
    };

    const booking = packages[packageType] || packages.pro;

    if (!customerEmail) {
      console.error("No customer email found in Stripe session.");
      return res.status(200).json({ received: true });
    }

    const customerHtml = `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;background:#111;color:#fff;padding:40px;">
        <h1 style="color:#e00000;">MRKLL STUDIOS</h1>
        <h2>Booking confirmed</h2>
        <p>Hi ${escapeHtml(customerName)},</p>
        <p>Your studio session has been successfully confirmed and paid.</p>

        <div style="margin:30px 0;padding:20px;background:#1c1c1c;">
          <p><strong>Session</strong><br>${escapeHtml(booking.name)}</p>
          <p><strong>Duration</strong><br>${escapeHtml(booking.duration)}</p>
          <p><strong>Date</strong><br>${escapeHtml(bookingDate)}</p>
          <p><strong>Time</strong><br>${escapeHtml(bookingTime)}</p>
          <p><strong>Amount paid</strong><br>${escapeHtml(booking.price)}</p>
        </div>

        <p>Thank you for booking with MRKLL Studios.</p>
        <p style="color:#aaa;">Where Frequencies Become Reality.</p>
      </div>
    `;

    const studioHtml = `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;">
        <h1>New MRKLL Studio Booking</h1>
        <hr>
        <p><strong>Customer:</strong> ${escapeHtml(customerName)}</p>
        <p><strong>Email:</strong> ${escapeHtml(customerEmail)}</p>
        <p><strong>Package:</strong> ${escapeHtml(booking.name)}</p>
        <p><strong>Duration:</strong> ${escapeHtml(booking.duration)}</p>
        <p><strong>Date:</strong> ${escapeHtml(bookingDate)}</p>
        <p><strong>Time:</strong> ${escapeHtml(bookingTime)}</p>
        <p><strong>Amount:</strong> ${escapeHtml(booking.price)}</p>
        <p><strong>Stripe Session:</strong> ${escapeHtml(session.id)}</p>
      </div>
    `;

    try {
      await sendBrevoEmail({
        to: customerEmail,
        toName: customerName,
        subject: "MRKLL Studios — Booking Confirmed",
        htmlContent: customerHtml,
      });

      await sendBrevoEmail({
        to: "studios@mrkll.com",
        toName: "MRKLL Studios",
        subject: `New Booking — ${booking.name}`,
        htmlContent: studioHtml,
      });

      console.log("Booking emails sent successfully.");
    } catch (error) {
      console.error("Brevo email error:", error.message);
      return res.status(500).json({ error: "Email delivery failed" });
    }
  }

  return res.status(200).json({ received: true });
};
