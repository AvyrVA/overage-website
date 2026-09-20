/* site.js — mobile nav and the intake form. No dependencies. */
(function () {
  'use strict';

  /* ------------------------------------------------------------------
     INTAKE ENDPOINT
     GitHub Pages is static and cannot receive a form POST. Put a hosted
     form endpoint here (Formspree, Basin, your CRM) and submissions are
     sent as JSON. The endpoint must also record the originating IP,
     reject submissions whose consent flags were not set by the user,
     and store the payload encrypted at rest.

     While it is empty, the form opens the visitor's email app with their
     details filled in, addressed to the intake mailbox below, and says so
     plainly. It never claims a submission it did not make.
     ------------------------------------------------------------------ */
  var INTAKE_ENDPOINT = '';
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

      /* Consent record: capture exactly what the visitor saw. SMS consent is optional. */
      var sms = el('consent_sms');
      el('consent_terms_text').value = labelText(terms);
      el('consent_sms_text').value = sms.checked ? labelText(sms) : '';
      el('captured_at').value = new Date().toISOString();
      el('page_url').value = window.location.href;
      el('user_agent').value = navigator.userAgent;

      var data = {};
      Array.prototype.forEach.call(form.elements, function (f) {
        if (!f.name) { return; }
        data[f.name] = f.type === 'checkbox' ? f.checked : f.value;
      });

      if (INTAKE_ENDPOINT) {
        var btn = form.querySelector('button[type="submit"]');
        btn.disabled = true;
        fetch(INTAKE_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify(data)
        }).then(function (r) {
          if (!r.ok) { throw new Error(r.status); }
          done('<h3>Received.</h3><p>We will look up the sale and send you a written case review within two business days. Questions before then: call <a href="tel:+19362871001">' + PHONE + '</a>.</p>');
        }).catch(function () {
          btn.disabled = false;
          fail('Something went wrong sending the form. Please call ' + PHONE + ' or email ' + INTAKE_EMAIL + '.');
        });
        return;
      }

      /* No endpoint yet: hand off to the visitor's email app. */
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
      done('<h3>One more step: send the email.</h3><p>Your email app should have opened with your details filled in, addressed to ' + INTAKE_EMAIL + '. Press send and we will reply with your case review within two business days.</p><p>If nothing opened, <a href="' + href.replace(/"/g, '&quot;') + '">open the email again</a>, or call <a href="tel:+19362871001">' + PHONE + '</a>.</p>');
      window.location.href = href;
    });
  });
})();
