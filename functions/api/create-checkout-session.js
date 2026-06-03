// Cloudflare Pages Function — creates a Stripe Embedded Checkout session.
// Lives at POST /api/create-checkout-session when deployed on Cloudflare Pages.
//
// SETUP (one time, in Cloudflare dashboard):
//   Workers & Pages → velosify-webdesign → Settings → Variables and Secrets
//   Add secret:  STRIPE_SECRET_KEY = sk_live_...   (your Stripe secret key)
//
// The price IDs below are PUBLIC identifiers (not secrets) — they come from
// Stripe Dashboard → Product catalog → each product → the one-off price's
// API ID (starts with "price_").

const PRICES = {
  launch: 'price_REPLACE_LAUNCH',
  growth: 'price_REPLACE_GROWTH',
  scale: 'price_REPLACE_SCALE',
};

export async function onRequestPost(context) {
  try {
    const { tier } = await context.request.json();
    const price = PRICES[tier];
    if (!price || price.includes('REPLACE')) {
      return json({ error: 'Unknown or unconfigured package.' }, 400);
    }
    const origin = new URL(context.request.url).origin;
    const body = new URLSearchParams({
      mode: 'payment',
      ui_mode: 'embedded',
      'line_items[0][price]': price,
      'line_items[0][quantity]': '1',
      return_url: origin + '/?payment=success',
    });
    const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${context.env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    const session = await res.json();
    if (session.error) {
      return json({ error: session.error.message }, 500);
    }
    return json({ clientSecret: session.client_secret });
  } catch (e) {
    return json({ error: 'Bad request.' }, 400);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
