/**
 * Intake endpoint for undistributedfund.com.
 *
 * GitHub Pages is static, so the form posts here instead. This Worker is the
 * only place a submission is ever handled, and it exists because the TCPA
 * consent record has to be made by something we control:
 *
 *   1. It records the originating IP itself (CF-Connecting-IP), rather than
 *      trusting a number the browser claims.
 *   2. It rejects a submission whose consent flags were not set by user
 *      action — the checkbox has to have been ticked, and the tick has to have
 *      a timestamp that falls between the page load and the submit.
 *   3. It stores the payload encrypted at rest. The Worker holds only a public
 *      key; nothing in Cloudflare can read a submission back. The private key
 *      lives with the business.
 *   4. It keeps the exact consent text as the visitor saw it, and checks that
 *      text against the manifest the site was built from, so a record can't
 *      quietly describe language that was never on the page.
 *
 * A consent defense is only as good as the record of what the consumer saw.
 * Everything below is in service of that record.
 */

import MANIFEST from '../consent-manifest.json';

const MAX_BODY_BYTES = 32 * 1024;

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const allowed = allowlist(env);

    if (request.method === 'OPTIONS') {
      return allowed.includes(origin)
        ? new Response(null, { status: 204, headers: cors(origin) })
        : new Response(null, { status: 403 });
    }

    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST, OPTIONS' } });
    }

    // No CORS headers on a disallowed origin: the browser will refuse to read
    // the response, which is the point.
    if (!allowed.includes(origin)) {
      return json({ ok: false, error: 'origin_not_allowed' }, 403);
    }

    const ip = request.headers.get('CF-Connecting-IP') || '';
    const headers = cors(origin);

    // --- rate limit, before doing any real work -----------------------------
    const limit = Number(env.MAX_PER_IP_PER_DAY || 8);
    const rlKey = 'rl:' + (await sha256hex(ip + '|' + (env.RATE_SALT || 'ure')));
    const seen = Number((await env.INTAKE.get(rlKey)) || 0);
    if (seen >= limit) {
      return json(
        {
          ok: false,
          error: 'rate_limited',
          message: 'We have already received several requests from this connection today. Please call us and we will take the details over the phone.',
        },
        429,
        headers
      );
    }

    // --- parse --------------------------------------------------------------
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) {
      return json({ ok: false, error: 'too_large' }, 413, headers);
    }
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return json({ ok: false, error: 'bad_request' }, 400, headers);
    }
    if (!body || typeof body !== 'object') {
      return json({ ok: false, error: 'bad_request' }, 400, headers);
    }

    // --- validate -----------------------------------------------------------
    const verdict = validate(body, allowed, env);
    if (!verdict.ok) {
      return json({ ok: false, error: verdict.error, message: verdict.message }, verdict.status, headers);
    }

    const received_at = new Date().toISOString();
    const reference = makeReference(received_at);
    const flags = verdict.flags;

    // --- the record ---------------------------------------------------------
    // Everything the business or counsel would need to reconstruct what the
    // consumer saw and did, in one object, before it is encrypted.
    const record = {
      reference,
      received_at,
      form_version: str(body.form_version),
      lead: {
        name: str(body.name),
        property_address: str(body.property_address),
        phone: str(body.phone),
        email: str(body.email),
        notes: str(body.notes),
      },
      consent: {
        terms: {
          accepted: true,
          accepted_at: str(body.consent_terms_at),
          text_as_rendered: str(body.consent_terms_text),
          text_sha256: await sha256hex(str(body.consent_terms_text)),
          matches_published_text: flags.includes('consent_text_mismatch') ? false : true,
        },
        sms: {
          accepted: verdict.smsAccepted,
          accepted_at: verdict.smsAccepted ? str(body.consent_sms_at) : '',
          text_as_rendered: verdict.smsAccepted ? str(body.consent_sms_text) : '',
          text_sha256: verdict.smsAccepted ? await sha256hex(str(body.consent_sms_text)) : '',
          matches_published_text: verdict.smsAccepted
            ? !flags.includes('sms_text_mismatch')
            : null,
        },
      },
      // Captured by this Worker, not by the browser. The browser cannot set these.
      origin_record: {
        ip,
        ip_country: request.headers.get('CF-IPCountry') || '',
        cf_ray: request.headers.get('CF-Ray') || '',
        tls_version: (request.cf && request.cf.tlsVersion) || '',
      },
      // Claimed by the browser. Kept because it is part of what the consumer
      // saw, labelled because it is not independently verified.
      client_record: {
        page_url: str(body.page_url),
        user_agent: str(body.user_agent),
        form_loaded_at: str(body.form_loaded_at),
        submitted_at: str(body.captured_at),
        dwell_ms: verdict.dwell,
        referrer: str(body.referrer),
      },
      flags,
    };

    // --- encrypt, then store ------------------------------------------------
    let sealed;
    try {
      sealed = await seal(record, env.INTAKE_PUBLIC_KEY);
    } catch (e) {
      // Never fall back to storing plaintext. If encryption is broken the
      // submission is refused and the visitor is told to call.
      console.error('seal failed', e && e.message);
      return json(
        {
          ok: false,
          error: 'storage_unavailable',
          message: 'We could not record your request securely just now. Please call us and we will take the details over the phone.',
        },
        503,
        headers
      );
    }

    const kvKey = `sub:${received_at}:${reference}`;
    const retentionDays = Number(env.RETENTION_DAYS || 1825); // 5 years
    await env.INTAKE.put(kvKey, JSON.stringify(sealed), {
      expirationTtl: Math.max(60, Math.round(retentionDays * 86400)),
      metadata: { reference, received_at, form_version: record.form_version, flags },
    });

    ctx.waitUntil(env.INTAKE.put(rlKey, String(seen + 1), { expirationTtl: 86400 }));

    // Spam gets recorded but never reaches the inbox or the working log.
    if (!flags.includes('honeypot')) {
      ctx.waitUntil(notify(env, record, kvKey));
      ctx.waitUntil(logToSheet(env, record));
    }

    return json({ ok: true, reference }, 200, headers);
  },
};

/* ---------------------------------------------------------------- validation */

function validate(body, allowed, env) {
  const flags = [];

  // Honeypot. A real visitor never sees this field. Accept quietly and record
  // it, so a false positive doesn't silently lose a lead, but send no email.
  if (str(body.fax_number)) flags.push('honeypot');

  const version = str(body.form_version);
  if (version !== MANIFEST.form_version) {
    return bad('unknown_form_version', 400, 'This form is out of date. Please reload the page and try again.');
  }

  const name = str(body.name);
  const address = str(body.property_address);
  const phone = str(body.phone);
  const email = str(body.email);
  if (!name) return bad('missing_name', 422, 'Please tell us your name.');
  if (!address) return bad('missing_address', 422, 'Please give us the property address so we can look it up.');
  if (!phone && !email) {
    return bad('missing_contact', 422, 'Please give us a phone number or an email address so we can send you the case review.');
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return bad('bad_email', 422, 'That email address does not look complete.');
  }

  // The page the submission claims to come from has to be one of ours.
  const pageUrl = str(body.page_url);
  let pageOrigin = '';
  try {
    pageOrigin = new URL(pageUrl).origin;
  } catch {
    /* left empty */
  }
  if (!allowed.includes(pageOrigin)) {
    return bad('bad_page_url', 400, 'This form could not be verified. Please reload the page and try again.');
  }

  /* ---- consent: the part that has to hold up ---------------------------- */

  // Required consent must be boolean true — not "on", not "true", not 1. The
  // form serialises a real checkbox's .checked, so anything else is a
  // hand-built payload.
  if (body.consent_terms !== true) {
    return bad(
      'consent_required',
      422,
      'Please confirm you have read the Terms of Service and Privacy Policy.'
    );
  }

  const loaded = ts(body.form_loaded_at);
  const submitted = ts(body.captured_at);
  const ticked = ts(body.consent_terms_at);

  // Evidence that a person ticked the box: a timestamp written by the
  // checkbox's own change event, sitting between page load and submit. A
  // payload that sets the flag without ever firing the event has none.
  if (!loaded || !submitted || !ticked) {
    return bad('consent_unverified', 422, consentUnverifiedMessage);
  }
  if (ticked < loaded - 2000 || ticked > submitted + 2000) {
    return bad('consent_unverified', 422, consentUnverifiedMessage);
  }

  const dwell = submitted - loaded;
  const minDwell = Number(env.MIN_DWELL_MS || 3000);
  if (dwell < minDwell) {
    return bad('too_fast', 422, 'Please take a moment to check the details, then submit again.');
  }

  // The text the visitor actually saw, against the text the site was built
  // from. A mismatch does not lose the lead — the record keeps what was on
  // screen either way — but it is flagged, loudly, in the notification.
  const termsText = str(body.consent_terms_text);
  if (!termsText) return bad('consent_unverified', 422, consentUnverifiedMessage);
  if (termsText !== MANIFEST.terms.text) flags.push('consent_text_mismatch');

  /* ---- SMS consent: optional, and it never gates submission -------------- */

  let smsAccepted = body.consent_sms === true;
  if (smsAccepted) {
    const smsTicked = ts(body.consent_sms_at);
    const smsText = str(body.consent_sms_text);
    // Unverifiable SMS consent is downgraded to "not given" rather than
    // rejected. Losing an optional opt-in costs nothing; recording one we
    // cannot evidence costs a great deal.
    if (!smsTicked || smsTicked < loaded - 2000 || smsTicked > submitted + 2000 || !smsText) {
      smsAccepted = false;
      flags.push('sms_consent_downgraded');
    } else if (smsText !== MANIFEST.sms.text) {
      flags.push('sms_text_mismatch');
    }
  }

  return { ok: true, flags, dwell, smsAccepted };
}

const consentUnverifiedMessage =
  'We could not verify the consent checkbox on this submission. Please reload the page, tick the box again, and resubmit — or call us and we will take the details over the phone.';

function bad(error, status, message) {
  return { ok: false, error, status, message };
}

/* ------------------------------------------------------------- encryption */

/**
 * Hybrid seal: a fresh AES-256-GCM key per submission, wrapped to the
 * business's RSA-OAEP public key. The Worker can write records and can never
 * read one back — decryption needs the private key, which is not on this
 * machine, in this account, or in this repo.
 */
async function seal(record, spkiB64) {
  if (!spkiB64) throw new Error('INTAKE_PUBLIC_KEY is not set');

  const aesKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(record));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, plaintext);

  const rawAes = await crypto.subtle.exportKey('raw', aesKey);
  const pub = await crypto.subtle.importKey(
    'spki',
    b64decode(spkiB64),
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['encrypt']
  );
  const wrapped = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, pub, rawAes);

  return {
    v: 1,
    alg: 'RSA-OAEP-SHA256 + AES-256-GCM',
    reference: record.reference,
    received_at: record.received_at,
    key: b64encode(wrapped),
    iv: b64encode(iv),
    ct: b64encode(ciphertext),
  };
}

/* ---------------------------------------------------------- notification */

async function notify(env, record, kvKey) {
  if (!env.RESEND_API_KEY || !env.NOTIFY_TO || !env.NOTIFY_FROM) return;

  const minimal = String(env.NOTIFY_MODE || 'full').toLowerCase() === 'minimal';
  const warn = record.flags.filter((f) => f.endsWith('mismatch') || f === 'sms_consent_downgraded');

  const subject = minimal
    ? `Case review request ${record.reference}`
    : `Case review request ${record.reference} — ${record.lead.property_address}`;

  const lines = minimal
    ? [
        `A new case review request was received and stored encrypted.`,
        ``,
        `Reference:  ${record.reference}`,
        `Received:   ${record.received_at}`,
        `Record:     ${kvKey}`,
        ``,
        `Read it with:  node tools/intake.mjs read ${record.reference}`,
      ]
    : [
        `Reference:  ${record.reference}`,
        `Received:   ${record.received_at}`,
        ``,
        `Name:       ${record.lead.name}`,
        `Property:   ${record.lead.property_address}`,
        `Phone:      ${record.lead.phone || '—'}`,
        `Email:      ${record.lead.email || '—'}`,
        ``,
        `Notes:`,
        record.lead.notes || '—',
        ``,
        `— Consent record ————————————————————————————————`,
        `Terms & Privacy:  accepted ${record.consent.terms.accepted_at}`,
        `                  text matches published: ${record.consent.terms.matches_published_text}`,
        `SMS:              ${record.consent.sms.accepted ? 'accepted ' + record.consent.sms.accepted_at : 'not given'}`,
        `Originating IP:   ${record.origin_record.ip} (${record.origin_record.ip_country})`,
        `Page:             ${record.client_record.page_url}`,
        `Form version:     ${record.form_version}`,
        `Time on page:     ${Math.round(record.client_record.dwell_ms / 1000)}s`,
        ``,
        `Full encrypted record:  ${kvKey}`,
        `Read it with:  node tools/intake.mjs read ${record.reference}`,
      ];

  if (warn.length) {
    lines.unshift(
      `!! REVIEW BEFORE RELYING ON THIS CONSENT RECORD: ${warn.join(', ')}`,
      `   The consent text this visitor saw does not match the text the site`,
      `   was last built from. Usually this means the Worker was not redeployed`,
      `   after a copy change. Check before treating this as a consent defense.`,
      ``
    );
  }

  const payload = {
    from: env.NOTIFY_FROM,
    to: [env.NOTIFY_TO],
    subject,
    text: lines.join('\n'),
  };
  if (!minimal && record.lead.email) payload.reply_to = record.lead.email;

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (!r.ok) console.error('notify failed', r.status, await r.text());
  } catch (e) {
    // The submission is already stored. A failed email is not a failed intake.
    console.error('notify threw', e && e.message);
  }
}

/* --------------------------------------------------- working log (Sheets) */

/**
 * Appends the lead to a Google Sheet, so the business has a pipeline it can
 * work from without decrypting anything.
 *
 * Deliberately NOT written here: the originating IP, the user agent, and the
 * verbatim consent text. Those are the TCPA record. They stay only in the
 * encrypted copy, where a row cannot be quietly edited months later. A
 * spreadsheet is a working list; it is not evidence, and it should never be
 * the thing anyone reaches for to prove what a consumer agreed to.
 */
const SHEET_COLUMNS = [
  'Received', 'Reference', 'Name', 'Property address',
  'Phone', 'Email', 'Notes', 'SMS opt-in', 'Flags',
];

async function logToSheet(env, record) {
  if (!env.GOOGLE_SA_KEY || !env.SHEET_ID) return;
  const tab = env.SHEET_TAB || 'Sheet1';
  try {
    const token = await googleToken(env);
    await ensureHeaders(env, tab, token);

    const row = [
      record.received_at,
      record.reference,
      record.lead.name,
      record.lead.property_address,
      record.lead.phone,
      record.lead.email,
      record.lead.notes,
      record.consent.sms.accepted ? 'yes' : 'no',
      record.flags.join(', '),
    ];

    const r = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}/values/` +
        `${encodeURIComponent(tab + '!A:I')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: [row] }),
      }
    );
    if (!r.ok) console.error('sheet append failed', r.status, (await r.text()).slice(0, 300));
  } catch (e) {
    // The encrypted record is already stored. A failed log is not a failed intake.
    console.error('sheet log threw', e && e.message);
  }
}

/** Writes the header row once, if the sheet is empty. Flagged in KV so it costs one read per month, not one per submission. */
async function ensureHeaders(env, tab, token) {
  if (await env.INTAKE.get('sheet:headers')) return;

  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}/values/` +
    encodeURIComponent(tab + '!A1:I1');

  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`sheet read ${r.status}: ${(await r.text()).slice(0, 200)}`);

  const body = await r.json();
  if (!body.values || !body.values.length) {
    const w = await fetch(url + '?valueInputOption=RAW', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [SHEET_COLUMNS] }),
    });
    if (!w.ok) throw new Error(`header write ${w.status}: ${(await w.text()).slice(0, 200)}`);
  }
  await env.INTAKE.put('sheet:headers', '1', { expirationTtl: 86400 * 30 });
}

/**
 * Service-account JWT exchanged for an OAuth access token, cached in KV until
 * shortly before it expires, so a burst of submissions signs once rather than
 * once each.
 */
async function googleToken(env) {
  const cached = await env.INTAKE.get('google:token');
  if (cached) return cached;

  const sa = JSON.parse(env.GOOGLE_SA_KEY);
  const now = Math.floor(Date.now() / 1000);
  const enc = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const input =
    `${enc({ alg: 'RS256', typ: 'JWT' })}.` +
    `${enc({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/spreadsheets',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    })}`;

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToDer(sa.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(input)
  );

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${input}.${b64url(sig)}`,
    }),
  });
  const body = await r.json();
  if (!body.access_token) {
    throw new Error(`google token ${r.status}: ${JSON.stringify(body).slice(0, 200)}`);
  }

  await env.INTAKE.put('google:token', body.access_token, {
    expirationTtl: Math.max(60, (body.expires_in || 3600) - 120),
  });
  return body.access_token;
}

function pemToDer(pem) {
  return b64decode(String(pem).replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''));
}

function b64url(buf) {
  return b64encode(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/* ------------------------------------------------------------------ utils */

function allowlist(env) {
  return String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...(headers || {}) },
  });
}

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function ts(v) {
  const t = Date.parse(str(v));
  return Number.isFinite(t) ? t : 0;
}

/** URE-YYMMDD-XXXX. Short enough to read down a phone, unique enough to file by. */
function makeReference(iso) {
  const d = iso.slice(2, 10).replace(/-/g, '');
  const alphabet = '23456789ACDEFGHJKLMNPQRTUVWXY'; // no 0/O/1/I/B/S
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  let tail = '';
  for (const b of bytes) tail += alphabet[b % alphabet.length];
  return `URE-${d}-${tail}`;
}

async function sha256hex(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function b64encode(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function b64decode(s) {
  const bin = atob(String(s).replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}
