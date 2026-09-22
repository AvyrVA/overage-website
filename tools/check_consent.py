"""Parse the built pages and confirm each consent label's textContent is
character-for-character the string in worker/consent-manifest.json.

This is the check that matters: if these drift, every stored consent record
gets flagged and the A2P 10DLC text stops matching sms-terms.html.
"""
import json, re, sys
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
M = json.loads((ROOT / "worker/consent-manifest.json").read_text())


class LabelText(HTMLParser):
    """textContent of <label for="TARGET">, the way a browser computes it."""

    def __init__(self, target):
        super().__init__(convert_charrefs=True)
        self.target, self.depth, self.buf = target, 0, []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "label" and a.get("for") == self.target:
            self.depth = 1
        elif self.depth:
            self.depth += 1

    def handle_endtag(self, tag):
        if self.depth:
            self.depth -= 1

    def handle_data(self, data):
        if self.depth:
            self.buf.append(data)

    def text(self):
        return re.sub(r"\s+", " ", "".join(self.buf)).strip()


def label_text(html, target):
    p = LabelText(target)
    p.feed(html)
    return p.text()


ok = True
for page, prefix in (("start.html", "start"), ("index.html", "home")):
    html = (ROOT / page).read_text()
    for kind, field in (("terms", "consent-terms"), ("sms", "consent-sms")):
        got = label_text(html, f"{prefix}-{field}")
        want = M[kind]["text"]
        mark = "ok  " if got == want else "FAIL"
        if got != want:
            ok = False
        print(f"  {mark} {page} {kind} consent label matches the manifest")
        if got != want:
            print(f"       rendered: {got[:120]!r}")
            print(f"       manifest: {want[:120]!r}")

# The SMS opt-in on sms-terms.html must be identical to the checkbox, minus the
# "Optional" badge. A mismatch is a common A2P 10DLC rejection reason.
sms_page = (ROOT / "sms-terms.html").read_text()
body = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", sms_page))
import html as htmlmod

body = htmlmod.unescape(body)
checkbox_sms = M["sms"]["text"].removeprefix("Optional").strip()
found = checkbox_sms in body
print(f"  {'ok  ' if found else 'FAIL'} sms-terms.html contains the checkbox text verbatim")
if not found:
    ok = False

# Every hidden field the Worker needs must exist on both forms.
required = ["consent_terms_text", "consent_sms_text", "consent_terms_at", "consent_sms_at",
            "form_loaded_at", "captured_at", "page_url", "referrer", "user_agent",
            "form_version", "fax_number"]
for page in ("start.html", "index.html"):
    html_src = (ROOT / page).read_text()
    missing = [f for f in required if f'name="{f}"' not in html_src]
    print(f"  {'ok  ' if not missing else 'FAIL'} {page} carries every consent field")
    if missing:
        ok = False
        print("       missing:", missing)

sys.exit(0 if ok else 1)
