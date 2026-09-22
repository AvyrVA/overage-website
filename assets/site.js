/* site.js — mobile nav and the intake form. No dependencies. */
(function () {
  'use strict';

  /* ------------------------------------------------------------------
     INTAKE ENDPOINT
     GitHub Pages is static and cannot receive a form POST, so the form
     posts JSON to the Worker in worker/ instead. That endpoint records
     the originating IP itself, refuses a submission whose consent flags
     were not set by user action, and stores the payload encrypted at
     rest. See worker/DEPLOY.md.

     If this is ever emptied, the form falls back to opening the
     visitor's email app with their details filled in, and says so
     plainly. It never claims a submission it did not make.

     The workers.dev host is Cloudflare's auto-assigned account
     subdomain and cannot be renamed — it is one-time per account. It is
     never shown to a visitor, only visible in a network inspector.
     ------------------------------------------------------------------ */
  var INTAKE_ENDPOINT = 'https://ure-intake.green-flower-1bc5.workers.dev';
  var INTAKE_EMAIL = 'ana@undistributedfund.com';
  var PHONE = '936-287-1001';

  /* ---------- mobile nav ---------- */
  var toggle = document.querySelector('.navtoggle');
  var nav = document.getElementById('mainnav');
  if (toggle && nav) {
    toggle.addEventListener('click', function () {
      var open = nav.classList.toggle('is-open');
      toggle.setAttribute('aria-expanded', String(open));
      toggle.querySelector('span').textContent = open ? 'Close' : 'Menu';
    });
  }

  /* ---------- intake form(s) ---------- */
  function labelText(input) {
    var l = document.querySelector('label[for="' + input.id + '"]');
    return l ? l.textContent.replace(/\s+/g, ' ').trim() : '';
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  Array.prototype.forEach.call(document.querySelectorAll('form.intake'), function (form) {
    var p = form.getAttribute('data-prefix');
    var err = document.getElementById(p + '-error');
    var ok = document.getElementById(p + '-ok');
    var el = function (n) { return form.elements[n]; };

    function fail(msg, field) {
      err.textContent = msg;
      err.classList.add('is-visible');
      if (field) { field.setAttribute('aria-invalid', 'true'); field.focus(); }
      return false;
    }

    function done(html) {
      form.hidden = true;
      ok.innerHTML = html;
      ok.classList.add('is-visible');
      ok.focus();
    }

    form.addEventListener('input', function (e) { e.target.removeAttribute('aria-invalid'); });

    /* --------------------------------------------------------------
       The consent record starts here, not at submit.

       A ticked box on its own proves nothing — anything can set
       .checked. What makes the record hold up is that the tick has a
       timestamp of its own, written by the checkbox's change event,
       sitting between the page load and the submit. The endpoint
       refuses a consent flag that arrives without one. Don't set these
       anywhere else.
       -------------------------------------------------------------- */
    el('form_loaded_at').value = new Date().toISOString();

    function stampConsent(box, stampField) {
      if (!box) { return; }
      box.addEventListener('change', function () {
        el(stampField).value = box.checked ? new Date().toISOString() : '';
      });
    }
    stampConsent(el('consent_terms'), 'consent_terms_at');
    stampConsent(el('consent_sms'), 'consent_sms_at');

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      err.classList.remove('is-visible');

      var name = el('name'), addr = el('property_address'), phone = el('phone'), email = el('email');
      if (!name.value.trim()) { return fail('Please tell us your name.', name); }
      if (!addr.value.trim()) { return fail('Please give us the property address so we can look it up.', addr); }
      if (!phone.value.trim() && !email.value.trim()) { return fail('Please give us a phone number or an email address so we can send you the case review.', phone); }
      if (email.value.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value.trim())) { return fail('That email address does not look complete.', email); }
      var terms = el('consent_terms');
      if (!terms.checked) { return fail('Please confirm you have read the Terms of Service and Privacy Policy.', terms); }

      /* Capture exactly what the visitor saw. SMS consent is optional. */
      var sms = el('consent_sms');
      el('consent_terms_text').value = labelText(terms);
      el('consent_sms_text').value = sms.checked ? labelText(sms) : '';
      el('captured_at').value = new Date().toISOString();
      el('page_url').value = window.location.href;
      el('referrer').value = document.referrer || '';
      el('user_agent').value = navigator.userAgent;

      var data = {};
      Array.prototype.forEach.call(form.elements, function (f) {
        if (!f.name) { return; }
        data[f.name] = f.type === 'checkbox' ? f.checked : f.value;
      });

      if (INTAKE_ENDPOINT) {
        var btn = form.querySelector('button[type="submit"]');
        var label = btn.innerHTML;
        btn.disabled = true;
        btn.textContent = 'Sending…';

        var restore = function () { btn.disabled = false; btn.innerHTML = label; };

        fetch(INTAKE_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify(data)
        }).then(function (r) {
          return r.json().catch(function () { return {}; }).then(function (payload) {
            return { status: r.status, ok: r.ok, payload: payload };
          });
        }).then(function (res) {
          if (res.ok && res.payload.ok) {
            var ref = res.payload.reference
              ? '<p class="small">Your reference is <b>' + esc(res.payload.reference) + '</b>. Quote it if you call us before then.</p>'
              : '';
            done('<h3>Received.</h3><p>We will look up the sale and send you a written case review within two business days. Questions before then: call <a href="tel:+19362871001">' + PHONE + '</a>.</p>' + ref);
            return;
          }
          restore();
          /* The endpoint returns a message written for the visitor when it
             can say something useful — a consent flag it could not verify,
             a stale form. Show that rather than a generic failure. */
          if (res.payload && res.payload.message) { return fail(res.payload.message); }
          fail('We could not send the form just now. Please call ' + PHONE + ' or email ' + INTAKE_EMAIL + ' and we will take the details directly.');
        }).catch(function () {
          restore();
          fail('We could not reach our system just now — this is usually a connection problem. Please try again, or call ' + PHONE + ' or email ' + INTAKE_EMAIL + '.');
        });
        return;
      }

      /* No endpoint configured: hand off to the visitor's email app. */
      var body = [
        'Name: ' + data.name,
        'Property address: ' + data.property_address,
        'Phone: ' + (data.phone || '-'),
        'Email: ' + (data.email || '-'),
        '',
        'Anything else: ' + (data.notes || '-'),
        '',
        'Agreed to Terms and Privacy Policy: yes (' + data.captured_at + ')',
        'SMS consent: ' + (data.consent_sms ? 'yes' : 'no')
      ].join('\n');
      var href = 'mailto:' + INTAKE_EMAIL + '?subject=' + encodeURIComponent('Case review request: ' + data.property_address) + '&body=' + encodeURIComponent(body);
      done('<h3>One more step: send the email.</h3><p>Your email app should have opened with your details filled in, addressed to ' + INTAKE_EMAIL + '. Press send and we will reply with your case review within two business days.</p><p>If nothing opened, <a href="' + esc(href) + '">open the email again</a>, or call <a href="tel:+19362871001">' + PHONE + '</a>.</p>');
      window.location.href = href;
    });
  });
})();
