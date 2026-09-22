# The intake endpoint

GitHub Pages is static and cannot receive a form POST, so `start.html` and the
homepage form post JSON here instead. This is a Cloudflare Worker: about 400
lines, no framework, free at this volume.

It is a Worker rather than Formspree or Basin because of what the README
already requires of the intake, and what those services cannot do:

| Requirement | Hosted form service | This |
|---|---|---|
| Record the originating IP | Usually yes | Yes, `CF-Connecting-IP`, not a number the browser claims |
| Reject consent flags not set by user action | **No** — they store whatever is POSTed | Yes, and the rejection is explained to the visitor |
| Store the payload encrypted at rest | Some, on paid tiers, with their key | Yes, with a key **they do not have** |
| No third-party branding or redirect page | Paid tiers only | Nothing leaves your domain; the visitor never sees this URL |
| Keep the exact consent text as rendered | Only if you post it yourself | Yes, and it is checked against what the site was built from |

The consent record is the whole point. A TCPA defense is the record of what
the consumer actually saw and did, and that record has to be made by something
you control.

---

## What it does with a submission

1. **Refuses anything not from your site.** CORS is restricted to
   `undistributedfund.com` and `www.`; the claimed `page_url` must also be one
   of those. No CORS headers go back to any other origin, so a copy of the form
   on another domain cannot submit here.
2. **Rate-limits** by a salted hash of the IP — 8 a day by default. The IP
   itself is never a KV key.
3. **Validates consent.** `consent_terms` must be boolean `true`, and it must
   be accompanied by `consent_terms_at` — a timestamp written by the
   checkbox's own `change` event, falling between page load and submit. A
   hand-built payload that just sets the flag has no such timestamp and is
   refused with `consent_unverified`. A submit faster than 3 seconds after load
   is refused too.
4. **Checks the consent text** the visitor saw against `consent-manifest.json`,
   which `tools/build.py` generates from the same string that renders in the
   form. A mismatch does not lose the lead — the record keeps what was on
   screen either way — but it is flagged in the record and at the top of the
   notification email.
5. **Records what the browser cannot fake** — IP, country, Cloudflare ray, TLS
   version — separately from what the browser claims (page URL, user agent,
   timestamps), so the two are never confused when the record is read back.
6. **Encrypts, then stores.** Fresh AES-256-GCM key per submission, wrapped to
   your RSA-OAEP-4096 public key. If encryption fails for any reason it returns
   503 and tells the visitor to call. It never falls back to plaintext.
7. **Emails you the lead** via Resend, and returns a reference number the page
   shows the visitor.

SMS consent is optional and never gates submission. If it arrives
unverifiable, it is downgraded to "not given" and the lead is kept — losing an
optional opt-in costs nothing, recording one you cannot evidence costs a lot.

---

## Setting it up

About fifteen minutes, once.

### 1. Make the key pair

```bash
cd worker
node tools/intake.mjs keygen
```

This writes `intake-private-key.pem` (mode 600, already gitignored) and prints
the public half.

> **Back the private key up before going further.** Put it wherever the signed
> fee agreements live. Every submission is encrypted to its public half — if
> you lose it, the stored records are unreadable by anyone, including you and
> including Cloudflare. There is no recovery path, by design.

### 2. Create the KV namespace

```bash
npx wrangler login
npx wrangler kv namespace create INTAKE
```

Paste the `id` it prints into `wrangler.toml`, and paste the public key into
`INTAKE_PUBLIC_KEY` in the same file.

### 3. Set the secrets

```bash
npx wrangler secret put RATE_SALT        # any long random string
npx wrangler secret put RESEND_API_KEY   # from resend.com, free tier is enough
```

Resend needs `undistributedfund.com` verified (three DNS records at GoDaddy) so
notifications arrive from `intake@undistributedfund.com` rather than a shared
sender. Without `RESEND_API_KEY` the Worker still stores submissions correctly
— it just doesn't email you, so you would be reading them with
`node tools/intake.mjs list`.

If you would rather no personal data sat in an inbox at all, set
`NOTIFY_MODE = "minimal"` in `wrangler.toml`. You then get a reference number
by email and read the lead with `intake.mjs read`. It is the stronger privacy
position and the slower workflow; `full` is the default because the site
promises a case review within two business days.

### 4. Deploy

```bash
npx wrangler deploy
```

It prints a URL like `https://ure-intake.<your-subdomain>.workers.dev`.

### 5. Point the site at it

In `assets/site.js`, replace the placeholder:

```js
var INTAKE_ENDPOINT = 'https://ure-intake.<your-subdomain>.workers.dev';
```

Commit and push. That is the whole deploy — GitHub Pages serves the form, the
Worker receives it.

A `workers.dev` URL is fine: it is a background `fetch`, so no visitor ever
sees it. If you later move DNS to Cloudflare you can put the Worker on
`intake.undistributedfund.com` instead — add the custom domain in the Worker's
settings, then change the one line above and the `ALLOWED_ORIGINS` var.

---

## Reading submissions

Run these from `worker/`, logged in as the account you deployed with.

```bash
node tools/intake.mjs list                  # references, dates, flags
node tools/intake.mjs read URE-260921-K4MQ  # the full decrypted record
```

`read` prints the lead, both consent records with the exact text as rendered
and its SHA-256, the originating IP, and the browser-reported fields kept
visibly separate from the ones the endpoint recorded itself. That printout is
what you would hand to counsel if a TCPA claim ever arrived.

Decryption happens entirely on your machine. The private key is never sent
anywhere.

## Retention

`RETENTION_DAYS = 1825` — five years, which covers the four-year TCPA
limitations period with a margin. Cloudflare deletes each record automatically
when it expires. **This is the number that belongs in `[RETENTION SCHEDULE]` on
`privacy.html`.** If counsel wants a different period, change it here and
there together.

## After changing consent copy

The consent text lives once, in `TERMS_CONSENT` / `SMS_CONSENT` in
`tools/build.py`. If you change either:

```bash
python3 tools/build.py     # rebuilds pages + consent-manifest.json, verifies both
cd worker && npx wrangler deploy
```

If you rebuild the site but forget to redeploy the Worker, nothing breaks —
submissions still arrive — but every record comes in flagged
`consent_text_mismatch` and the notification email says so at the top. That is
deliberate: a silently wrong consent record is worse than a loud one.

## Checking it works

```bash
curl -i -X POST https://ure-intake.<your-subdomain>.workers.dev \
  -H 'Origin: https://undistributedfund.com' \
  -H 'Content-Type: application/json' \
  -d '{"name":"Test","property_address":"1 Test St","email":"you@example.com","consent_terms":true,"form_version":"surplus-2026-09","page_url":"https://undistributedfund.com/start.html"}'
```

This should return **422 `consent_unverified`** — the flag is set but no
checkbox was ever ticked. That refusal is the feature working. Then submit the
real form once and confirm the email arrives and `intake.mjs read` decrypts it.

## If you ever hand this to someone non-technical

The swap is one line in `assets/site.js` — point `INTAKE_ENDPOINT` at a Basin
or Formspree AJAX endpoint and the form posts there instead, since it already
sends flat JSON. Understand what you give up: those services store the payload
under their key, and they accept whatever the browser posts, so the
consent-verification in step 3 above stops happening. The README's TCPA
requirements would no longer be met.
