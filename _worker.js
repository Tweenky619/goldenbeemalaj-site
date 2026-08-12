// Cloudflare Pages advanced-mode worker for goldenbeemalaj.com
// Handles POST /api/lead (write to D1 + email notification); serves static assets for everything else.
//
// Required Pages project settings (Settings > Bindings / Variables):
//   DB              - D1 database binding -> goldenbeemalaj-leads
//   CF_ACCOUNT_ID   - plain-text variable, Cloudflare account ID
//   EMAIL_API_TOKEN - secret, API token with Email Sending permission

const NOTIFY_TO = "goldenbeemalajjewelry@gmail.com"; // verified Email Routing destination
const NOTIFY_FROM = "leads@goldenbeemalaj.com";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Public lead submission
    if (url.pathname === "/api/lead") {
      if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
      return handleLead(request, env, ctx);
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

    // Serve /admin without the .html extension
    if (url.pathname === "/admin" || url.pathname === "/admin/") {
      const assetReq = new Request(new URL("/admin.html", url).toString(), request);
      return env.ASSETS.fetch(assetReq);
    }

    return env.ASSETS.fetch(request);
  },
};

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

  if (!name || !contact) {
    return json({ ok: false, error: "Please include your name and a way to reach you." }, 400);
  }

  try {
    await env.DB.prepare(
      "INSERT INTO leads (name, contact, interest, best_time, source_page) VALUES (?1, ?2, ?3, ?4, ?5)"
    )
      .bind(name, contact, interest || null, bestTime || null, sourcePage || null)
      .run();
  } catch (err) {
    console.log("D1 insert failed:", err.message);
    return json({ ok: false, error: "Something went wrong saving your info. Please call or email us instead." }, 500);
  }

  // Email is best-effort: the lead is already saved, so never fail the response over it.
  ctx.waitUntil(notify(env, { name, contact, interest, bestTime, sourcePage }));

  return json({ ok: true });
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
  const text = [
    "New lead from goldenbeemalaj.com",
    "",
    "Name:     " + lead.name,
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
          subject: "New lead: " + lead.name + (lead.interest ? " — " + lead.interest : ""),
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
    "SUMMARY:" + icsEscape("Call lead: " + lead.name + " (" + (lead.interest || "General inquiry") + ")"),
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

  const valid = ["new", "contacted", "confirmed", "completed", "no-reply"];
  if (!valid.includes(data.status)) return json({ ok: false, error: "Invalid status" }, 400);

  try {
    await env.DB.prepare("UPDATE leads SET status = ?1 WHERE id = ?2").bind(data.status, id).run();
    return json({ ok: true });
  } catch (err) {
    console.log("adminUpdateLead error:", err.message);
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
