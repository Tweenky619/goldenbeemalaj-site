// Cloudflare Pages advanced-mode worker for goldenbeemalaj.com
// Handles POST /api/lead (write to D1 + email notification); serves static assets for everything else.
//
// Required Pages project settings (Settings > Bindings / Variables):
//   DB                    - D1 database binding -> goldenbeemalaj-leads
//   CF_ACCOUNT_ID         - plain-text variable, Cloudflare account ID
//   EMAIL_API_TOKEN       - secret, API token with Email Sending permission
//   ADMIN_PASSWORD        - secret, admin dashboard password
//   STRIPE_SECRET_KEY     - secret, Stripe secret API key (checkout)
//   STRIPE_WEBHOOK_SECRET - secret, signing secret for the /api/webhook endpoint

const NOTIFY_TO = "goldenbeemalajjewelry@gmail.com"; // verified Email Routing destination
const NOTIFY_FROM = "leads@goldenbeemalaj.com";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Live gold spot price + 1yr daily history, cached at the edge
    if (url.pathname === "/api/gold-price") {
      if (request.method !== "GET") return json({ ok: false, error: "Method not allowed" }, 405);
      return handleGoldPrice(request, ctx);
    }

    // Public lead submission
    if (url.pathname === "/api/lead") {
      if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
      return handleLead(request, env, ctx);
    }

    // Create a Stripe Checkout Session for a denomination purchase
    if (url.pathname === "/api/checkout") {
      if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
      return handleCheckout(request, env);
    }

    // Stripe webhook — order fulfillment on successful payment
    if (url.pathname === "/api/webhook") {
      if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
      return handleStripeWebhook(request, env, ctx);
    }

    // Magic Data: auto-saves whatever's been typed into the lead form
    // before a visitor abandons it, so a half-finished form isn't a
    // total loss. Debounced client-side; upserted here by session id.
    if (url.pathname === "/api/lead/partial") {
      if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
      return handlePartialLead(request, env, ctx);
    }

    // Admin API — all routes require Bearer token matching ADMIN_PASSWORD
    if (url.pathname === "/api/admin/leads") {
      if (!(await adminAuthed(request, env))) return unauthorized();
      if (request.method === "GET") return adminListLeads(request, env);
      return json({ ok: false, error: "Method not allowed" }, 405);
    }

    const patchMatch = url.pathname.match(/^\/api\/admin\/leads\/(\d+)$/);
    if (patchMatch) {
      if (!(await adminAuthed(request, env))) return unauthorized();
      if (request.method === "PATCH") return adminUpdateLead(request, env, Number(patchMatch[1]));
      return json({ ok: false, error: "Method not allowed" }, 405);
    }

    if (url.pathname === "/api/admin/pricing") {
      if (!(await adminAuthed(request, env))) return unauthorized();
      if (request.method === "GET") return adminGetPricing(env);
      if (request.method === "POST") return adminSetPricing(request, env);
      return json({ ok: false, error: "Method not allowed" }, 405);
    }

    if (url.pathname === "/api/admin/orders") {
      if (!(await adminAuthed(request, env))) return unauthorized();
      if (request.method === "GET") return adminListOrders(request, env);
      return json({ ok: false, error: "Method not allowed" }, 405);
    }

    const orderPatchMatch = url.pathname.match(/^\/api\/admin\/orders\/(\d+)$/);
    if (orderPatchMatch) {
      if (!(await adminAuthed(request, env))) return unauthorized();
      if (request.method === "PATCH") return adminUpdateOrder(request, env, Number(orderPatchMatch[1]));
      return json({ ok: false, error: "Method not allowed" }, 405);
    }

    const assetResponse = await env.ASSETS.fetch(request);

    // These two scripts get edited often during active development; force
    // the browser to revalidate with the server on every load (still fast
    // via a 304 if unchanged) instead of reusing a stale cached copy for
    // hours after a deploy. A Pages `_headers` file can't reach this,
    // since this project's own _worker.js (Advanced Mode) intercepts every
    // request before Pages' static-file header pipeline would apply it.
    if (url.pathname === "/gb-shop.js" || url.pathname === "/ticker.js") {
      const response = new Response(assetResponse.body, assetResponse);
      response.headers.set("Cache-Control", "no-store");
      return response;
    }

    // /admin already resolves to admin.html via Pages' clean-URL asset
    // handling — rewriting to /admin.html here would just bounce back
    // a 308 (that path redirects to the clean URL), looping forever.
    return assetResponse;
  },
};

// ---- Live gold spot price ----

const GOLD_CACHE_URL = "https://internal.goldenbeemalaj.com/cache/gold-price"; // synthetic cache key, never fetched
const GOLD_CACHE_TTL = 1800; // seconds — both upstreams only publish new values once or so a day

// Goldback Inc.'s own calculator widget calls this endpoint client-side from
// every visitor's browser on goldback.com/exchange-rates — the key below is
// the one shipped in that page's public JS, not a private credential. It's
// not a documented/versioned public API, so this could break if they change
// it; the 30-min cache keeps our call volume low regardless.
const GOLDBACK_RATE_API = "https://gbcapi.gbdomainapi.xyz/GBCalculatorSettingsAPICSharpProdV1/CurrencyRates";
const GOLDBACK_RATE_API_KEY = "14b8cd90c80149a888d9986e22dbfb95";

async function handleGoldPrice(request, ctx) {
  const cache = caches.default;
  const cacheKey = new Request(GOLD_CACHE_URL);

  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  try {
    // A single call to the public history endpoint covers both the chart
    // and "current" price (its most recent day) — this API's anonymous
    // tier shares a 30 req/min quota across all of Cloudflare's egress IPs
    // (i.e. every Worker calling it anonymously, not just this one), so
    // keeping to one upstream request keeps us well clear of that ceiling.
    const historyRes = await fetch("https://api.goldprice.dev/v1/public/xau-history");
    if (!historyRes.ok) {
      throw new Error("Upstream gold price API error: " + historyRes.status);
    }

    const historyData = await historyRes.json();
    const series = (historyData.series || [])
      .slice()
      .reverse()
      .map((p) => ({ date: p.date, close: parseFloat(p.close) }));

    if (!series.length) throw new Error("Unexpected gold price response shape");
    const latest = series[series.length - 1];

    const body = {
      ok: true,
      price: latest.close,
      currency: "USD",
      unit: "troy_ounce",
      computedAt: latest.date,
      history: series,
      goldbackRate: await fetchGoldbackRate(),
    };

    const response = json(body);
    response.headers.set("Cache-Control", "public, max-age=" + GOLD_CACHE_TTL);
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  } catch (err) {
    console.log("handleGoldPrice error:", err.message);
    // 200, not 5xx: Cloudflare's edge substitutes its own generic error
    // page for 5xx responses, which would hide this JSON from the client.
    return json({ ok: false, error: "Gold price temporarily unavailable." });
  }
}

async function handleLead(request, env, ctx) {
  let data;
  try {
    data = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid request." }, 400);
  }

  // Honeypot: real visitors never fill this hidden field. Pretend success to bots.
  if (data.company) return json({ ok: true });

  const name = clean(data.name, 120);
  const contact = clean(data.contact, 200);
  const interest = clean(data.interest, 120);
  const bestTime = clean(data.best_time, 60);
  const sourcePage = clean(data.source_page, 250);
  const sessionId = clean(data.client_session_id, 100);

  if (!name || !contact) {
    return json({ ok: false, error: "Please include your name and a way to reach you." }, 400);
  }

  try {
    // If this session already has a Magic-Data partial (abandoned) row,
    // promote it in place instead of inserting a duplicate lead.
    let promoted = false;
    if (sessionId) {
      const upd = await env.DB.prepare(
        "UPDATE leads SET name = ?1, contact = ?2, interest = ?3, best_time = ?4, source_page = ?5, status = 'new' WHERE client_session_id = ?6"
      )
        .bind(name, contact, interest || null, bestTime || null, sourcePage || null, sessionId)
        .run();
      promoted = upd.meta.changes > 0;
    }
    if (!promoted) {
      await env.DB.prepare(
        "INSERT INTO leads (name, contact, interest, best_time, source_page, client_session_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6)"
      )
        .bind(name, contact, interest || null, bestTime || null, sourcePage || null, sessionId || null)
        .run();
    }
  } catch (err) {
    console.log("D1 insert failed:", err.message);
    return json({ ok: false, error: "Something went wrong saving your info. Please call or email us instead." }, 500);
  }

  // Email is best-effort: the lead is already saved, so never fail the response over it.
  ctx.waitUntil(notify(env, { name, contact, interest, bestTime, sourcePage }));

  return json({ ok: true });
}

async function handlePartialLead(request, env, ctx) {
  let data;
  try {
    data = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid request." }, 400);
  }

  if (data.company) return json({ ok: true }); // honeypot

  const sessionId = clean(data.client_session_id, 100);
  if (!sessionId) return json({ ok: false, error: "Missing session id." }, 400);

  const name = clean(data.name, 120);
  const contact = clean(data.contact, 200);
  const interest = clean(data.interest, 120);
  const bestTime = clean(data.best_time, 60);
  const sourcePage = clean(data.source_page, 250);

  // Not worth saving until there's at least a way to reach them back.
  if (!contact) return json({ ok: true, skipped: true });

  try {
    const upd = await env.DB.prepare(
      "UPDATE leads SET name = ?1, contact = ?2, interest = ?3, best_time = ?4, source_page = ?5 WHERE client_session_id = ?6 AND status = 'abandoned'"
    )
      .bind(name, contact, interest || null, bestTime || null, sourcePage || null, sessionId)
      .run();

    if (upd.meta.changes === 0) {
      // No abandoned row updated — either this session was already
      // promoted to a real lead (full submit), or this is the first
      // time we've seen it abandon the form.
      const existing = await env.DB.prepare("SELECT 1 FROM leads WHERE client_session_id = ?1 LIMIT 1")
        .bind(sessionId)
        .first();
      if (!existing) {
        await env.DB.prepare(
          "INSERT INTO leads (name, contact, interest, best_time, source_page, client_session_id, status) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'abandoned')"
        )
          .bind(name, contact, interest || null, bestTime || null, sourcePage || null, sessionId)
          .run();
        ctx.waitUntil(notify(env, { name, contact, interest, bestTime, sourcePage, abandoned: true }));
      }
    }
  } catch (err) {
    console.log("D1 partial-lead upsert failed:", err.message);
    return json({ ok: false, error: "Could not save." }, 500);
  }

  return json({ ok: true });
}

async function fetchGoldbackRate() {
  try {
    const res = await fetch(GOLDBACK_RATE_API, {
      headers: { "Content-Type": "application/json", "Ocp-Apim-Subscription-Key": GOLDBACK_RATE_API_KEY },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const rate = data.success && data.quotes && parseFloat(data.quotes.USDUSD);
    return rate > 0 ? rate : null;
  } catch (err) {
    console.log("fetchGoldbackRate error:", err.message);
    return null; // informational only — never fail the whole gold-price response over this
  }
}

// ---- Checkout (Stripe) ----

async function handleCheckout(request, env) {
  let data;
  try {
    data = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid request." }, 400);
  }

  const rawItems = Array.isArray(data.items) ? data.items : null;
  if (!rawItems || !rawItems.length) {
    return json({ ok: false, error: "Your cart is empty." }, 400);
  }
  if (rawItems.length > 10) {
    return json({ ok: false, error: "Please check out in batches of 10 items or fewer." }, 400);
  }

  const items = [];
  for (const raw of rawItems) {
    const series = clean(raw.series, 60);
    const denomination = clean(raw.denomination, 40);
    const faceValueGB = parseFloat(raw.faceValueGB);
    const quantity = Math.max(1, Math.min(999, parseInt(raw.quantity, 10) || 1));
    if (!series || !denomination || !(faceValueGB > 0)) {
      return json({ ok: false, error: "Missing or invalid product details." }, 400);
    }
    items.push({ series, denomination, faceValueGB, quantity });
  }

  if (!env.STRIPE_SECRET_KEY) {
    return json({ ok: false, error: "Checkout is temporarily unavailable — please try again shortly or call/email us to order." }, 400);
  }

  let pricing;
  try {
    pricing = await env.DB.prepare("SELECT price_per_goldback_cents FROM pricing ORDER BY id DESC LIMIT 1").first();
  } catch (err) {
    console.log("checkout pricing lookup failed:", err.message);
    return json({ ok: false, error: "Could not load current pricing." }, 500);
  }
  if (!pricing) {
    return json({ ok: false, error: "Checkout is temporarily unavailable — please try again shortly or call/email us to order." }, 400);
  }

  const origin = new URL(request.url).origin;
  const lineItems = items.map((item) => ({
    quantity: item.quantity,
    price_data: {
      currency: "usd",
      unit_amount: Math.round(item.faceValueGB * pricing.price_per_goldback_cents),
      product_data: {
        name: item.series + " " + item.denomination + " Goldback",
        description: "Real 24-karat gold currency note — " + item.faceValueGB + " GB face value.",
      },
    },
  }));

  // Free shipping at $199.99+ subtotal, flat $9.99 below that — decided
  // server-side from the actual cart total, not left for the customer to pick.
  const FREE_SHIPPING_THRESHOLD_CENTS = 19999;
  const FLAT_SHIPPING_CENTS = 999;
  const subtotalCents = lineItems.reduce((sum, li) => sum + li.price_data.unit_amount * li.quantity, 0);
  const shippingCents = subtotalCents >= FREE_SHIPPING_THRESHOLD_CENTS ? 0 : FLAT_SHIPPING_CENTS;
  const shippingLabel = shippingCents === 0 ? "Free Shipping" : "Standard Shipping";

  try {
    const session = await stripeCreateCheckoutSession(env, {
      mode: "payment",
      success_url: origin + "/order-confirmation?session_id={CHECKOUT_SESSION_ID}",
      cancel_url: origin + "/order-cancelled",
      line_items: lineItems,
      shipping_address_collection: { allowed_countries: ["US"] },
      shipping_options: [
        {
          shipping_rate_data: {
            type: "fixed_amount",
            fixed_amount: { amount: shippingCents, currency: "usd" },
            display_name: shippingLabel,
            delivery_estimate: {
              minimum: { unit: "business_day", value: 2 },
              maximum: { unit: "business_day", value: 6 },
            },
          },
        },
      ],
      automatic_tax: { enabled: true },
      metadata: {
        // Compact keys (s/d/f/q) to stay well under Stripe's 500-char metadata value limit.
        items: JSON.stringify(items.map((i) => ({ s: i.series, d: i.denomination, f: i.faceValueGB, q: i.quantity }))),
      },
    });
    return json({ ok: true, url: session.url });
  } catch (err) {
    console.log("Stripe checkout session creation failed:", err.message);
    return json({ ok: false, error: "Could not start checkout. Please try again or request a quote." }, 500);
  }
}

async function handleStripeWebhook(request, env, ctx) {
  const sig = request.headers.get("Stripe-Signature");
  const payload = await request.text();

  if (!env.STRIPE_WEBHOOK_SECRET) {
    console.log("Stripe webhook received but STRIPE_WEBHOOK_SECRET is not configured.");
    return json({ ok: false, error: "Webhook not configured" }, 400);
  }
  if (!(await verifyStripeSignature(payload, sig, env.STRIPE_WEBHOOK_SECRET.replace(/\s+/g, "")))) {
    return json({ ok: false, error: "Invalid signature" }, 400);
  }

  let event;
  try {
    event = JSON.parse(payload);
  } catch {
    return json({ ok: false, error: "Invalid payload" }, 400);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const details = session.customer_details || {};
    const shipping = session.shipping_details || details || {};

    let items = [];
    try {
      items = JSON.parse((session.metadata || {}).items || "[]");
    } catch (err) {
      console.log("could not parse order metadata:", err.message);
    }

    try {
      // One row per line item, all sharing stripe_session_id (not unique —
      // a cart order is multiple rows). Check first so a Stripe webhook
      // retry doesn't insert the same order twice.
      const existing = await env.DB.prepare("SELECT COUNT(*) AS n FROM orders WHERE stripe_session_id = ?1")
        .bind(session.id)
        .first();

      if (existing && existing.n > 0) {
        console.log("order already recorded for session " + session.id + " — skipping duplicate webhook delivery");
      } else if (items.length) {
        const lineItems = await stripeGetLineItems(env, session.id);
        for (let i = 0; i < items.length; i++) {
          const it = items[i];
          const li = lineItems[i] || {};
          await env.DB.prepare(
            "INSERT INTO orders (stripe_session_id, series, denomination, face_value_gb, quantity, amount_cents, customer_email, customer_name, shipping_address, status) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'paid')"
          )
            .bind(
              session.id,
              it.s || "",
              it.d || "",
              parseFloat(it.f) || 0,
              parseInt(it.q, 10) || 1,
              li.amount_total || 0,
              details.email || null,
              details.name || null,
              JSON.stringify(shipping)
            )
            .run();
        }
        ctx.waitUntil(notifyOrder(env, session, items, lineItems));
      }
    } catch (err) {
      console.log("order insert failed:", err.message);
    }
  }

  return json({ ok: true });
}

async function notifyOrder(env, session, items, lineItems) {
  if (!env.EMAIL_API_TOKEN || !env.CF_ACCOUNT_ID) {
    console.log("Order email notification skipped: EMAIL_API_TOKEN / CF_ACCOUNT_ID not configured.");
    return;
  }
  const details = session.customer_details || {};
  const shipping = (session.shipping_details && session.shipping_details.address) || details.address || null;
  const addrText = shipping
    ? [shipping.line1, shipping.line2, shipping.city, shipping.state, shipping.postal_code, shipping.country]
        .filter(Boolean)
        .join(", ")
    : "(no shipping address captured)";
  const amount = ((session.amount_total || 0) / 100).toFixed(2);

  const itemLines = items.map((it, i) => {
    const li = lineItems[i] || {};
    const liAmount = ((li.amount_total || 0) / 100).toFixed(2);
    return "  - " + (it.s || "") + " " + (it.d || "") + " ×" + (it.q || 1) + " — $" + liAmount;
  });

  const subjectSummary = items.map((it) => (it.s || "") + " " + (it.d || "") + " ×" + (it.q || 1)).join(", ");

  const text = [
    "New paid order from goldenbeemalaj.com",
    "",
    "Items:",
    ...itemLines,
    "",
    "Total paid:   $" + amount,
    "Customer:     " + (details.name || "—") + " <" + (details.email || "—") + ">",
    "Ship to:      " + addrText,
    "",
    "Mark it shipped in the admin Orders tab once it goes out.",
  ].join("\n");

  try {
    const res = await fetch(
      "https://api.cloudflare.com/client/v4/accounts/" + env.CF_ACCOUNT_ID + "/email/sending/send",
      {
        method: "POST",
        headers: { Authorization: "Bearer " + env.EMAIL_API_TOKEN, "Content-Type": "application/json" },
        body: JSON.stringify({
          to: NOTIFY_TO,
          from: NOTIFY_FROM,
          subject: "New order: " + subjectSummary + " — $" + amount,
          text: text,
        }),
      }
    );
    if (!res.ok) console.log("Order email send failed:", res.status, await res.text());
  } catch (err) {
    console.log("Order email send error:", err.message);
  }
}

// ---- Stripe REST helpers (no SDK — plain fetch, consistent with the rest of this worker) ----

async function stripeCreateCheckoutSession(env, params) {
  const form = toStripeForm(params, "", new URLSearchParams());
  // Stripe API keys never legitimately contain whitespace — stripping all of
  // it (not just the edges) guards against a stray newline from however the
  // secret was copied into the dashboard, a common source of a fetch()
  // "Invalid header value" error.
  const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + env.STRIPE_SECRET_KEY.replace(/\s+/g, ""),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error((data.error && data.error.message) || "Stripe error");
  return data;
}

async function stripeGetLineItems(env, sessionId) {
  const res = await fetch("https://api.stripe.com/v1/checkout/sessions/" + sessionId + "/line_items?limit=100", {
    headers: { Authorization: "Bearer " + env.STRIPE_SECRET_KEY.replace(/\s+/g, "") },
  });
  const data = await res.json();
  if (!res.ok) throw new Error((data.error && data.error.message) || "Stripe error");
  return data.data || [];
}

// Stripe's REST API expects PHP-style bracket-indexed form encoding for
// nested objects/arrays, e.g. line_items[0][price_data][unit_amount]=1234.
function toStripeForm(obj, prefix, form) {
  Object.keys(obj).forEach(function (key) {
    var value = obj[key];
    var fullKey = prefix ? prefix + "[" + key + "]" : key;
    if (value === null || value === undefined) return;
    if (typeof value === "object") {
      toStripeForm(value, fullKey, form);
    } else {
      form.append(fullKey, String(value));
    }
  });
  return form;
}

async function verifyStripeSignature(payload, sigHeader, secret) {
  if (!sigHeader) return false;
  var parts = {};
  sigHeader.split(",").forEach(function (kv) {
    var i = kv.indexOf("=");
    if (i > 0) parts[kv.slice(0, i)] = kv.slice(i + 1);
  });
  var timestamp = parts.t;
  var sig = parts.v1;
  if (!timestamp || !sig) return false;

  // Reject stale signatures (Stripe recommends a 5-minute tolerance against replay attacks).
  var age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!(age < 300)) return false;

  var key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  var macBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(timestamp + "." + payload));
  var macHex = Array.from(new Uint8Array(macBuf))
    .map(function (b) { return b.toString(16).padStart(2, "0"); })
    .join("");

  if (macHex.length !== sig.length) return false;
  var diff = 0;
  for (var i = 0; i < macHex.length; i++) diff |= macHex.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

async function notify(env, lead) {
  if (!env.EMAIL_API_TOKEN || !env.CF_ACCOUNT_ID) {
    console.log("Email notification skipped: EMAIL_API_TOKEN / CF_ACCOUNT_ID not configured.");
    return;
  }
  const when = new Date().toLocaleString("en-US", {
    timeZone: LA_TZ,
    dateStyle: "medium",
    timeStyle: "short",
  });
  const win = computeCallWindow(lead.bestTime, Date.now());
  const winLabel =
    fmtLA(win.startMs, { weekday: "short", month: "short", day: "numeric" }) +
    " · " +
    fmtLA(win.startMs, { hour: "numeric", minute: "2-digit" }) +
    " – " +
    fmtLA(win.endMs, { hour: "numeric", minute: "2-digit" }) +
    " Pacific";
  const who = lead.name || lead.contact;
  const text = [
    lead.abandoned
      ? "Someone started filling out the lead form on goldenbeemalaj.com but didn't finish — here's what they entered before dropping off:"
      : "New lead from goldenbeemalaj.com",
    "",
    "Name:     " + (lead.name || "(not entered yet)"),
    "Contact:  " + lead.contact,
    "Interest: " + (lead.interest || "(not specified)"),
    "Call at:  " + (lead.bestTime || "(not specified)"),
    "Page:     " + (lead.sourcePage || "(unknown)"),
    "When:     " + when + " (Pacific)",
    "",
    "Suggested call slot: " + winLabel,
    "A calendar invite is attached — open it and tap Add to put the call on your Google Calendar.",
    "",
    "All leads are stored in the D1 database 'goldenbeemalaj-leads'.",
  ].join("\n");

  try {
    const res = await fetch(
      "https://api.cloudflare.com/client/v4/accounts/" + env.CF_ACCOUNT_ID + "/email/sending/send",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + env.EMAIL_API_TOKEN,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          to: NOTIFY_TO,
          from: NOTIFY_FROM,
          subject: (lead.abandoned ? "Abandoned form: " : "New lead: ") + who + (lead.interest ? " — " + lead.interest : ""),
          text: text,
          attachments: [
            {
              content: toBase64Utf8(buildIcs(lead, win.startMs, win.endMs)),
              filename: "call-reminder.ics",
              type: "text/calendar; charset=utf-8; method=REQUEST",
              disposition: "attachment",
            },
          ],
        }),
      }
    );
    if (!res.ok) {
      console.log("Email send failed:", res.status, await res.text());
    }
  } catch (err) {
    console.log("Email send error:", err.message);
  }
}

// ---- Call-window scheduling (America/Los_Angeles) ----

const LA_TZ = "America/Los_Angeles";
const CALL_WINDOWS = { Morning: [9, 12], Afternoon: [12, 17], Evening: [17, 20] };
const OPEN_HOUR = 10, LAST_CALL_HOUR = 19; // Mon–Sat 10am–8pm; last "Anytime" slot starts 7pm

function laParts(ms) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: LA_TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", weekday: "short", hour12: false,
  }).formatToParts(new Date(ms));
  const get = (t) => parts.find((p) => p.type === t).value;
  return { y: +get("year"), mo: +get("month"), d: +get("day"), h: +get("hour") % 24, mi: +get("minute"), wd: get("weekday") };
}

// Convert an LA wall-clock time to a UTC timestamp (two-pass to absorb DST offset).
function laToUtcMs(y, mo, d, h, mi) {
  let utc = Date.UTC(y, mo - 1, d, h, mi);
  for (let i = 0; i < 2; i++) {
    const w = laParts(utc);
    utc += Date.UTC(y, mo - 1, d, h, mi) - Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi);
  }
  return utc;
}

function nextDayLA(y, mo, d) {
  const dt = new Date(Date.UTC(y, mo - 1, d + 1, 12));
  return { y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

export function computeCallWindow(bestTime, nowMs) {
  const now = laParts(nowMs);
  const key = Object.keys(CALL_WINDOWS).find((k) => bestTime && bestTime.indexOf(k) === 0);
  let y = now.y, mo = now.mo, d = now.d;
  let startH, endH;
  if (key) {
    const ws = CALL_WINDOWS[key][0], we = CALL_WINDOWS[key][1];
    startH = Math.max(ws, now.h + 1);
    endH = we;
    if (startH >= we) {
      ({ y, mo, d } = nextDayLA(y, mo, d));
      startH = ws;
    }
  } else {
    startH = Math.max(now.h + 1, OPEN_HOUR);
    if (startH > LAST_CALL_HOUR) {
      ({ y, mo, d } = nextDayLA(y, mo, d));
      startH = OPEN_HOUR;
    }
    endH = startH + 1;
  }
  // Closed Sundays — push to Monday at the window's opening time.
  let guard = 0;
  while (laParts(laToUtcMs(y, mo, d, 12, 0)).wd === "Sun" && guard++ < 3) {
    ({ y, mo, d } = nextDayLA(y, mo, d));
    if (key) { startH = CALL_WINDOWS[key][0]; endH = CALL_WINDOWS[key][1]; }
    else { startH = OPEN_HOUR; endH = OPEN_HOUR + 1; }
  }
  return { startMs: laToUtcMs(y, mo, d, startH, 0), endMs: laToUtcMs(y, mo, d, endH, 0) };
}

function fmtLA(ms, opts) {
  return new Intl.DateTimeFormat("en-US", Object.assign({ timeZone: LA_TZ }, opts)).format(new Date(ms));
}

// ---- iCalendar invite ----

function icsEscape(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

function icsDate(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

export function buildIcs(lead, startMs, endMs) {
  const uid = "lead-" + Date.now() + "-" + Math.floor(Math.random() * 1e6) + "@goldenbeemalaj.com";
  const desc =
    "Contact: " + lead.contact +
    "\nInterest: " + (lead.interest || "General inquiry") +
    "\nRequested: " + (lead.bestTime || "Anytime") +
    "\nFrom page: " + (lead.sourcePage || "(unknown)");
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Goldenbee MALAJ Jewelry//Lead Call Reminder//EN",
    "METHOD:REQUEST",
    "BEGIN:VEVENT",
    "UID:" + uid,
    "DTSTAMP:" + icsDate(Date.now()),
    "DTSTART:" + icsDate(startMs),
    "DTEND:" + icsDate(endMs),
    "SUMMARY:" + icsEscape("Call lead: " + (lead.name || lead.contact) + " (" + (lead.interest || "General inquiry") + ")"),
    "DESCRIPTION:" + icsEscape(desc),
    "ORGANIZER;CN=Goldenbee MALAJ Leads:mailto:" + NOTIFY_FROM,
    "ATTENDEE;CN=Goldenbee MALAJ;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:" + NOTIFY_TO,
    "STATUS:CONFIRMED",
    "BEGIN:VALARM",
    "TRIGGER:PT0M",
    "ACTION:DISPLAY",
    "DESCRIPTION:Call this lead now",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}

function toBase64Utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

// ---- Admin auth ----

async function adminAuthed(request, env) {
  if (!env.ADMIN_PASSWORD) return false;
  const auth = request.headers.get("Authorization") || "";
  const tok = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!tok) return false;
  // Constant-time comparison to resist timing attacks.
  const enc = new TextEncoder();
  const a = await crypto.subtle.digest("SHA-256", enc.encode(tok));
  const b = await crypto.subtle.digest("SHA-256", enc.encode(env.ADMIN_PASSWORD));
  const va = new Uint8Array(a), vb = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

function unauthorized() {
  return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
    status: 401,
    headers: { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" },
  });
}

// ---- Admin handlers ----

async function adminListLeads(request, env) {
  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "200", 10) || 200, 500);
  const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10) || 0);

  try {
    let stmt;
    if (status && status !== "all") {
      stmt = env.DB.prepare(
        "SELECT id, name, contact, interest, best_time, source_page, created_at, status FROM leads WHERE status = ?1 ORDER BY created_at DESC LIMIT ?2 OFFSET ?3"
      ).bind(status, limit, offset);
    } else {
      stmt = env.DB.prepare(
        "SELECT id, name, contact, interest, best_time, source_page, created_at, status FROM leads ORDER BY created_at DESC LIMIT ?1 OFFSET ?2"
      ).bind(limit, offset);
    }
    const result = await stmt.all();
    const total = (await env.DB.prepare("SELECT COUNT(*) AS n FROM leads").first()).n;
    return json({ ok: true, leads: result.results, total });
  } catch (err) {
    console.log("adminListLeads error:", err.message);
    return json({ ok: false, error: "Database error" }, 500);
  }
}

async function adminUpdateLead(request, env, id) {
  let data;
  try { data = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }

  const valid = ["new", "contacted", "confirmed", "completed", "no-reply", "abandoned"];
  if (!valid.includes(data.status)) return json({ ok: false, error: "Invalid status" }, 400);

  try {
    await env.DB.prepare("UPDATE leads SET status = ?1 WHERE id = ?2").bind(data.status, id).run();
    return json({ ok: true });
  } catch (err) {
    console.log("adminUpdateLead error:", err.message);
    return json({ ok: false, error: "Database error" }, 500);
  }
}

// ---- Admin: pricing ----

async function adminGetPricing(env) {
  try {
    const row = await env.DB.prepare(
      "SELECT price_per_goldback_cents, updated_at FROM pricing ORDER BY id DESC LIMIT 1"
    ).first();
    return json({ ok: true, pricing: row || null });
  } catch (err) {
    console.log("adminGetPricing error:", err.message);
    return json({ ok: false, error: "Database error" }, 500);
  }
}

async function adminSetPricing(request, env) {
  let data;
  try {
    data = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }
  const cents = Math.round(parseFloat(data.price_per_goldback) * 100);
  if (!(cents > 0)) return json({ ok: false, error: "Invalid price." }, 400);

  try {
    await env.DB.prepare("INSERT INTO pricing (price_per_goldback_cents) VALUES (?1)").bind(cents).run();
    return json({ ok: true });
  } catch (err) {
    console.log("adminSetPricing error:", err.message);
    return json({ ok: false, error: "Database error" }, 500);
  }
}

// ---- Admin: orders ----

async function adminListOrders(request, env) {
  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "200", 10) || 200, 500);

  try {
    const result = await env.DB.prepare(
      "SELECT id, stripe_session_id, series, denomination, face_value_gb, quantity, amount_cents, customer_email, customer_name, shipping_address, status, created_at FROM orders ORDER BY created_at DESC LIMIT ?1"
    )
      .bind(limit)
      .all();
    return json({ ok: true, orders: result.results });
  } catch (err) {
    console.log("adminListOrders error:", err.message);
    return json({ ok: false, error: "Database error" }, 500);
  }
}

async function adminUpdateOrder(request, env, id) {
  let data;
  try {
    data = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }

  const valid = ["paid", "shipped", "delivered", "refunded"];
  if (!valid.includes(data.status)) return json({ ok: false, error: "Invalid status" }, 400);

  try {
    await env.DB.prepare("UPDATE orders SET status = ?1 WHERE id = ?2").bind(data.status, id).run();
    return json({ ok: true });
  } catch (err) {
    console.log("adminUpdateOrder error:", err.message);
    return json({ ok: false, error: "Database error" }, 500);
  }
}

// ---- Shared helpers ----

function clean(value, maxLen) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, maxLen);
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { "Content-Type": "application/json" },
  });
}
