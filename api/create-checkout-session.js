const Stripe = require("stripe");

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

module.exports = async (req, res) => {

    if (req.method !== "POST") {
        return res.status(405).json({
            error: "Method not allowed"
        });
    }

    try {

        const {
            packageType,
            date,
            time
        } = req.body;

        let amount;
        let productName;

        switch (packageType) {

            case "starter":
                amount = 12000;
                productName = "MRKLL Recording Starter";
                break;

            case "legend":
                amount = 28000;
                productName = "MRKLL Recording Legend";
                break;

            default:
                amount = 20000;
                productName = "MRKLL Recording Pro";
        }

        const session = await stripe.checkout.sessions.create({

            mode: "payment",

            payment_method_types: ["card"],

            line_items: [
                {
                    price_data: {
                        currency: "eur",

                        product_data: {
                            name: productName
                        },

                        unit_amount: amount
                    },

                    quantity: 1
                }
            ],

            metadata: {
                packageType: packageType || "",
                date: date || "",
                time: time || ""
            },

            success_url:
            "https://mrkll-v1.vercel.app/booking-success.html?session_id={CHECKOUT_SESSION_ID}",
        cancel_url:
            "https://YOUR-DOMAIN.com/checkout.html"
        });

        return res.status(200).json({
            url: session.url
        });

    } catch (error) {

        console.error("Stripe error:", error);

        return res.status(500).json({
            error: "Unable to create Stripe Checkout session"
        });
    }
};