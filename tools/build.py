#!/usr/bin/env python3
"""
Builds every page at the repo root from tools/pages/*.html.

Each page file starts with a meta comment:
  <!--meta title="..." description="..." nav="home" -->
followed by the page's <main> content. The script wraps it in the shared
<head>, header, nav, footer and inline icon sprite, so those are identical on
every page. Run:  python3 tools/build.py

Tokens available inside page files:
  {{PHONE}} {{TEL}} {{EMAIL}} {{ADDRESS}} {{NAME}} {{YEAR}}
  {{FORM:<id-prefix>}}   the intake form (used on index.html and start.html)
  {{I:<icon>}}           an inline <svg> icon from the sprite
"""
import re, pathlib, html

ROOT = pathlib.Path(__file__).resolve().parent.parent
PAGES = ROOT / "tools" / "pages"

SITE = {
    "NAME": "Undistributed Refund Experts",
    "PHONE": "936-287-1001",
    "TEL": "+19362871001",
    "EMAIL": "ana@undistributedfund.com",
    "ADDRESS": "8503 Magna St, Houston, TX 77093",
    "YEAR": "2026",
}

NAV = [
    ("home", "index.html", "Home"),
    ("how", "how-it-works.html", "How It Works"),
    ("cost", "what-it-costs.html", "What It Costs"),
    ("rights", "your-rights.html", "Your Rights"),
    ("about", "about.html", "About"),
    ("faq", "faq.html", "FAQ"),
]

# 24x24 stroke icons, drawn for this site.
ICONS = {
 "shield": '<path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z"/><path d="M9 12l2 2 4-4"/>',
 "percent": '<circle cx="7" cy="7" r="2.5"/><circle cx="17" cy="17" r="2.5"/><path d="M19 5L5 19"/>',
 "scale": '<path d="M12 4v16M8 20h8M5 7h14"/><path d="M5 7l-3 6a3 3 0 006 0zM19 7l-3 6a3 3 0 006 0z"/>',
 "pin": '<path d="M12 21s-7-6.2-7-11a7 7 0 0114 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>',
 "search": '<path d="M14 3H6a1 1 0 00-1 1v16a1 1 0 001 1h5"/><path d="M14 3l5 5v2M14 3v5h5"/><circle cx="16.5" cy="16.5" r="3"/><path d="M18.7 18.7L21 21"/>',
 "doc": '<path d="M14 3H6a1 1 0 00-1 1v16a1 1 0 001 1h12a1 1 0 001-1V8z"/><path d="M14 3v5h5M8 13h8M8 17h5"/>',
 "clock": '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
 "user": '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0116 0"/>',
 "users": '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0113 0"/><circle cx="17" cy="9" r="2.5"/><path d="M16 14.2a5 5 0 016 4.8"/>',
 "phone": '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 005 5L15 13l5 2v4a2 2 0 01-2 2A16 16 0 013 6a2 2 0 012-2"/>',
 "mail": '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
 "check": '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
 "x": '<path d="M6 6l12 12M18 6L6 18"/>',
 "lock": '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/>',
 "alert": '<path d="M12 3.5l9.5 16.5h-19z"/><path d="M12 10v4.5M12 17.5v.01"/>',
 "arrow": '<path d="M5 12h14M13 6l6 6-6 6"/>',
 "landmark": '<path d="M3 10h18L12 4z"/><path d="M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 21h18M4 18h16"/>',
 "home": '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>',
 "coins": '<ellipse cx="9" cy="7" rx="6" ry="3"/><path d="M3 7v4c0 1.7 2.7 3 6 3s6-1.3 6-3V7"/><path d="M9 14v3c0 1.7 2.7 3 6 3s6-1.3 6-3v-4c0-1.7-2.7-3-6-3"/>',
 "send": '<path d="M21 3L3 10.5l7 3 3 7z"/><path d="M10 13.5L21 3"/>',
 "chat": '<path d="M4 5h16v11H9l-5 4z"/><path d="M8 10h8"/>',
 "ban": '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>',
 "calendar": '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
 "pen": '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
 "route": '<circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M8 19h8a3 3 0 000-6H8a3 3 0 010-6h8"/>',
 "chevron": '<path d="M6 9l6 6 6-6"/>',
 "menu": '<path d="M4 7h16M4 12h16M4 17h16"/>',
 "eye": '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
 "hourglass": '<path d="M6 3h12M6 21h12M7 3c0 5 5 6 5 9s-5 4-5 9M17 3c0 5-5 6-5 9s5 4 5 9"/>',
 "wallet": '<path d="M4 7h15a1 1 0 011 1v11a1 1 0 01-1 1H5a1 1 0 01-1-1V6a2 2 0 012-2h11v3"/><circle cx="16" cy="13.5" r="1.3"/>',
 "handcoins": '<circle cx="15" cy="7" r="3.5"/><path d="M2 15h3l4 3h6a2 2 0 000-4h-4"/><path d="M5 21v-8"/><path d="M13 14l5-2.5a2 2 0 012 3.4L15 18"/>',
}

def icon(name, cls="icon"):
    if name not in ICONS:
        raise SystemExit(f"unknown icon: {name}")
    return f'<svg class="{cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">{ICONS[name]}</svg>'

# ----------------------------------------------------------------------------
# The two consent texts are shared by the form and sms-terms.html. They must
# stay character-for-character identical (A2P 10DLC vetting checks this).
# ----------------------------------------------------------------------------
TERMS_CONSENT = ('I have read and agree to the <a href="terms.html">Terms of Service</a> and '
  '<a href="privacy.html">Privacy Policy</a>. I understand that Undistributed Refund Experts '
  'is not a law firm and does not provide legal advice, and that legal work on my claim will be '
  'performed by a licensed attorney that Undistributed Refund Experts retains, whose fee is '
  'advanced by Undistributed Refund Experts and reimbursed out of any amount recovered.')

SMS_CONSENT = ('I consent to receive SMS notifications &amp; alerts from Undistributed Refund Experts '
  'at the mobile number provided, including case status updates and claim deadline reminders. '
  'Message frequency varies. Message &amp; data rates may apply. Reply STOP to unsubscribe, or '
  'HELP for help. See our <a href="privacy.html">Privacy Policy</a> and '
  '<a href="sms-terms.html">SMS Terms</a>. <b>Consent is not a condition of purchase or of '
  'receiving a case review.</b>')

def form(p):
    return f'''<div class="formcard">
  <h3>Check my case</h3>
  <p class="small">Tell us the address. We look it up in the public record and send you a written case review. It is free and obligates you to nothing.</p>
  <div class="formmsg formmsg--error" id="{p}-error" role="alert" tabindex="-1"></div>
  <form class="intake" id="{p}-form" data-prefix="{p}" novalidate>
    <div class="field">
      <label for="{p}-name">Your name</label>
      <input type="text" id="{p}-name" name="name" autocomplete="name" required>
    </div>
    <div class="field">
      <label for="{p}-address">Property address</label>
      <input type="text" id="{p}-address" name="property_address" autocomplete="street-address" required>
      <span class="hint">The property that sold, not necessarily where you live now.</span>
    </div>
    <div class="pair">
      <div class="field">
        <label for="{p}-phone">Phone</label>
        <input type="tel" id="{p}-phone" name="phone" autocomplete="tel">
      </div>
      <div class="field">
        <label for="{p}-email">Email</label>
        <input type="email" id="{p}-email" name="email" autocomplete="email">
      </div>
    </div>
    <p class="hint" style="margin:-8px 0 14px">A phone number or an email address is enough. Give us whichever you prefer.</p>
    <div class="field">
      <label for="{p}-notes">Anything you&rsquo;d like us to know <span class="opt">(optional)</span></label>
      <textarea id="{p}-notes" name="notes" maxlength="1500"></textarea>
    </div>
    <div class="consent">
      <input type="checkbox" id="{p}-consent-terms" name="consent_terms" required>
      <label for="{p}-consent-terms"><span class="req">Required</span>{TERMS_CONSENT}</label>
    </div>
    <!-- SMS consent: unticked, optional, never gates submission (TCPA / A2P 10DLC).
         Text must match sms-terms.html exactly. -->
    <div class="consent">
      <input type="checkbox" id="{p}-consent-sms" name="consent_sms">
      <label for="{p}-consent-sms"><span class="optl">Optional</span>{SMS_CONSENT}</label>
    </div>
    <input type="hidden" name="consent_terms_text"><input type="hidden" name="consent_sms_text">
    <input type="hidden" name="captured_at"><input type="hidden" name="page_url">
    <input type="hidden" name="user_agent"><input type="hidden" name="form_version" value="surplus-2026-09">
    <button type="submit" class="btn btn--teal btn--block">Check my case {icon("arrow")}</button>
    <p class="nossn">{icon("lock")}<span>We don&rsquo;t need your Social Security number or bank details to start. Just the address.</span></p>
  </form>
  <div class="formmsg formmsg--ok" id="{p}-ok" role="status" tabindex="-1"></div>
</div>'''

def header(cur):
    ac = lambda on: ' aria-current="page"' if on else ""
    items = "".join(
        f'<li><a href="{href}"{ac(key == cur)}>{label}</a></li>'
        for key, href, label in NAV)
    items += f'<li class="mobile-only"><a href="start.html"{ac(cur == "start")}>Start a Case</a></li>'
    items += f'<li class="mobile-only"><a href="tel:{SITE["TEL"]}">Call {SITE["PHONE"]}</a></li>'
    return f'''<a class="skip" href="#main">Skip to content</a>
<header class="site-header">
  <div class="shell">
    <a class="brand" href="index.html" aria-label="{SITE["NAME"]}, home">
      <img src="assets/img/logo.svg" alt="" width="54" height="54">
      <span><b>{SITE["NAME"]}</b><small>Surplus funds recovery</small></span>
    </a>
    <button class="navtoggle" type="button" aria-expanded="false" aria-controls="mainnav">{icon("menu")}<span>Menu</span></button>
    <nav class="mainnav" id="mainnav" aria-label="Main">
      <ul>{items}</ul>
    </nav>
    <div class="header-cta">
      <a class="header-phone" href="tel:{SITE["TEL"]}" aria-label="Call {SITE["PHONE"]}" title="Call {SITE["PHONE"]}">{icon("phone")}</a>
      <a class="btn" href="start.html">Start a Case</a>
    </div>
  </div>
</header>'''

FOOTER = f'''<footer class="site-footer">
  <div class="shell">
    <!-- Disclosures render first, at body size and full contrast, on every page.
         They are the argument, not the fine print. Wording changes need counsel. -->
    <section class="footdisc" aria-labelledby="disc-h">
      <h2 id="disc-h">Important disclosures</h2>
      <p><strong>{SITE["NAME"]} is not a law firm and does not provide legal advice.</strong> We identify surplus funds in the public record, assemble the documentation a claim requires, and coordinate the claim. Legal advice and legal filings are provided by a licensed attorney that {SITE["NAME"]} selects and retains. We advance that attorney&rsquo;s fee, and it is reimbursed out of any amount recovered before our percentage is calculated. The attorney&rsquo;s professional duties of confidentiality, loyalty and independent judgment run to you, and we do not direct the attorney&rsquo;s handling of your matter. Nothing on this website creates an attorney-client relationship.</p>
      <p>{SITE["NAME"]} is not associated with the government, and our service is not approved by the government, any county or court, or your former lender. We do not buy property, claims, or any interest in them.</p>
      <p>We do not collect any fee before a recovery. There are no upfront fees of any kind. If nothing is recovered, you owe nothing. If funds are recovered, third-party costs are reimbursed first and our fee is never more than 30% of what remains, as stated in dollars in the agreement before you sign.</p>
      <p>Dollar figures on this website are illustrative. They are not a quote, an estimate of your recovery, or a representation that any amount is available in your matter.</p>
    </section>
    <div class="footgrid">
      <div class="footbrand">
        <img src="assets/img/logo.svg" alt="{SITE["NAME"]} logo" width="120" height="120" loading="lazy">
        <p>Helping former owners and heirs claim money left over after a foreclosure or tax sale.</p>
      </div>
      <div>
        <h3>Company</h3>
        <ul>
          <li><a href="index.html">Home</a></li>
          <li><a href="how-it-works.html">How It Works</a></li>
          <li><a href="what-it-costs.html">What It Costs</a></li>
          <li><a href="about.html">About</a></li>
          <li><a href="faq.html">FAQ</a></li>
          <li><a href="start.html">Start a Case</a></li>
        </ul>
      </div>
      <div>
        <h3>Your rights &amp; legal</h3>
        <ul>
          <li><a href="your-rights.html">Your Rights &amp; Deadlines</a></li>
          <li><a href="terms.html">Terms of Service</a></li>
          <li><a href="privacy.html">Privacy Policy</a></li>
          <li><a href="sms-terms.html">SMS Terms</a></li>
        </ul>
      </div>
      <div>
        <h3>Contact</h3>
        <address>
          <a href="tel:{SITE["TEL"]}">{SITE["PHONE"]}</a>
          <a href="mailto:{SITE["EMAIL"]}">{SITE["EMAIL"]}</a>
          <span>{SITE["ADDRESS"]}</span>
          <a href="mailto:{SITE["EMAIL"]}?subject=Suspicious%20message">Report a suspicious message</a>
        </address>
      </div>
    </div>
    <div class="footbase">
      <p>&copy; 2021&ndash;{SITE["YEAR"]} {SITE["NAME"]}. All rights reserved.</p>
      <p>Private firm registered in Texas. Not a law firm. Not a government agency.</p>
    </div>
  </div>
</footer>'''

def render(src):
    text = src.read_text(encoding="utf-8")
    m = re.match(r'\s*<!--meta(.*?)-->\s*', text, re.S)
    if not m:
        raise SystemExit(f"{src.name}: missing meta comment")
    meta = dict(re.findall(r'(\w+)="(.*?)"', m.group(1), re.S))
    body = text[m.end():]
    head_extra = ""
    ld = re.search(r'<!--jsonld-->(.*?)<!--/jsonld-->', body, re.S)
    if ld:
        head_extra = ld.group(1).strip()
        body = body[:ld.start()] + body[ld.end():]
    body = re.sub(r'\{\{FORM:([\w-]+)\}\}', lambda m: form(m.group(1)), body)
    body = re.sub(r'\{\{I:([\w-]+)\}\}', lambda m: icon(m.group(1)), body)
    body = body.replace("{{SMS_CONSENT}}", SMS_CONSENT).replace("{{TERMS_CONSENT}}", TERMS_CONSENT)
    for k, v in SITE.items():
        body = body.replace("{{%s}}" % k, v)
    if meta.get("faqld"):
        import json
        qa = []
        for q, a in re.findall(r'<summary>.*?</svg>(.*?)</summary>\s*<div class="answer">(.*?)</div>', body, re.S):
            clean = lambda t: html.unescape(re.sub(r"<[^>]+>", "", t)).strip()
            qa.append({"@type": "Question", "name": clean(q),
                       "acceptedAnswer": {"@type": "Answer", "text": clean(a)}})
        head_extra += '<script type="application/ld+json">' + json.dumps(
            {"@context": "https://schema.org", "@type": "FAQPage", "mainEntity": qa}, ensure_ascii=False) + '</script>'
    title = meta["title"]
    if meta.get("nav") == "home":
        import json
        head_extra += '<script type="application/ld+json">' + json.dumps({"@context": "https://schema.org",
            "@type": "Organization", "name": SITE["NAME"], "telephone": SITE["PHONE"], "email": SITE["EMAIL"],
            "address": {"@type": "PostalAddress", "streetAddress": "8503 Magna St", "addressLocality": "Houston",
                        "addressRegion": "TX", "postalCode": "77093", "addressCountry": "US"}}) + '</script>'
    full_title = title if meta.get("nav") == "home" else f'{title} | {SITE["NAME"]}'
    desc = meta["description"]
    out = f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{html.escape(full_title)}</title>
<meta name="description" content="{html.escape(desc)}">
<meta name="theme-color" content="#224142">
<meta property="og:type" content="website">
<meta property="og:title" content="{html.escape(full_title)}">
<meta property="og:description" content="{html.escape(desc)}">
<meta property="og:site_name" content="{SITE["NAME"]}">
<link rel="icon" href="assets/img/favicon.svg" type="image/svg+xml">
<link rel="preload" href="assets/fonts/source-serif-4-latin.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="assets/fonts/public-sans-latin.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="assets/site.css">
{head_extra}
</head>
<body>
{header(meta.get("nav", ""))}
<main id="main">
{body.strip()}
</main>
{FOOTER}
<script src="assets/site.js" defer></script>
</body>
</html>
'''
    # Internal notes never ship: strip all HTML comments from the output.
    out = re.sub(r"<!--.*?-->\n?", "", out, flags=re.S)
    out_name = meta.get("file", src.stem + ".html")
    (ROOT / out_name).write_text(out, encoding="utf-8")
    return out_name

if __name__ == "__main__":
    built = [render(p) for p in sorted(PAGES.glob("*.html"))]
    print("built:", ", ".join(built))
