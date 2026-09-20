# Check images — how to add them

Drop your redacted files here with these exact names:

| File            | Card                                    |
|-----------------|-----------------------------------------|
| `case-01.jpg`   | Cook County, Illinois — 48-hour redemption |
| `case-02.jpg`   | Inherited property, three heirs         |
| `case-03.jpg`   | Relocated owner, lapsed exemption       |

That's it. The page detects each file and swaps it in automatically. If a file
isn't there, the card falls back to the redaction diagram — never a broken image
icon — so you can add them one at a time.

**Format:** JPEG, flattened, sRGB. Roughly 5:2 (e.g. 1000 × 400). Anything else
is letterboxed on a neutral ground rather than cropped, so nothing gets cut off.
Keep each file under ~300 KB.

Adding a fourth case? Copy a `<figure class="check">` block in `index.html`,
point it at `case-04.jpg`, and add the matching `<article class="case">`.

---

## Redaction spec — read before you export

**Cover with solid opaque rectangles.** Not blur. Not reduced opacity. Not a
box drawn in the browser. All three are reversible, and two of them are
reversible by anyone who downloads the file.

**Flatten before export.** Redact in your editor, then export a new flat JPEG.
Never ship a layered PSD/PDF or a file where the bars are a separate layer —
the original pixels travel underneath.

**Strip EXIF on the way out.** Camera, GPS, and edit history all ride along
otherwise.

### Must be covered

- Routing number, account number, and the full MICR line along the bottom
- Check number (top right, and again in the MICR line)
- Signature
- Payee full name
- Every street address, on the check and on any stub
- Bank branch name and identifiers
- Anything in the memo line — parcel numbers and case numbers are re-identifying

### May remain visible

- The dollar amount
- Month and year (drop the day)
- Issuing county or escrow entity, if it isn't identifying on its own

### Before you publish

Signed client authorization is required for every image, even fully redacted.
County + month + amount together can identify a person in a small jurisdiction.
Keep the authorization filed with the asset. If a client declines, run that card
without an image — the narrative stands on its own.

Verify your redaction by opening the exported JPEG and trying to select or
brighten the bars. If anything shows through, it isn't flattened.
