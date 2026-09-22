#!/usr/bin/env node
/**
 * intake.mjs — the only thing that can read a submission back.
 *
 * The Worker encrypts every intake to a public key. This reads them, using
 * the private key that lives on your machine and nowhere else. No
 * dependencies: Node's built-in crypto does all of it.
 *
 *   node tools/intake.mjs keygen
 *   node tools/intake.mjs list [--limit 50]
 *   node tools/intake.mjs read URE-260921-K4MQ
 *   node tools/intake.mjs read --key "sub:2026-09-21T14:02:11.004Z:URE-260921-K4MQ"
 *   node tools/intake.mjs decrypt record.json
 *
 * list/read shell out to wrangler, so run them from the worker/ directory
 * with the same login you deployed with.
 *
 * The private key is read from $INTAKE_PRIVATE_KEY (a path) or from
 * ./intake-private-key.pem. Keep it out of git. Keep a copy somewhere you
 * will still have it in five years — without it, the stored records are
 * unreadable by anyone, including you.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const [, , cmd, ...rest] = process.argv;

const commands = { keygen, list, read, decrypt };
if (!cmd || !commands[cmd]) {
  console.error(fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^[\s*/]*|\n \* ?/g, '\n').trim());
  process.exit(cmd ? 1 : 0);
}
try {
  await commands[cmd](rest);
} catch (e) {
  console.error('\n' + (e && e.message ? e.message : e) + '\n');
  process.exit(1);
}

/* ----------------------------------------------------------------- keygen */

async function keygen() {
  const out = path.resolve('intake-private-key.pem');
  if (fs.existsSync(out)) {
    throw new Error(
      `${out} already exists. Refusing to overwrite it — if you replace the key pair, every\n` +
        `submission stored under the old key becomes permanently unreadable. Move the old\n` +
        `file aside deliberately if that is what you mean to do.`
    );
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 4096,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  fs.writeFileSync(out, privateKey, { mode: 0o600 });

  console.log(`
Private key written to  ${out}  (mode 600)

  Back it up now, somewhere that survives this laptop — a password manager
  entry or a printed copy in the same place the fee agreements live. Every
  intake is encrypted to its public half. Lose it and the records are gone.

  It is already covered by .gitignore. Do not move it into the repo.

Public key — put this in worker/wrangler.toml as INTAKE_PUBLIC_KEY:

${publicKey.toString('base64')}
`);
}

/* ------------------------------------------------------------------- list */

async function list(args) {
  const limit = Number(flag(args, '--limit') || 50);
  const raw = wrangler(['kv', 'key', 'list', '--binding=INTAKE', '--remote']);
  const keys = JSON.parse(raw)
    .filter((k) => k.name.startsWith('sub:'))
    .sort((a, b) => (a.name < b.name ? 1 : -1))
    .slice(0, limit);

  if (!keys.length) return console.log('No submissions stored.');

  console.log(`${'Reference'.padEnd(20)} ${'Received'.padEnd(26)} Flags`);
  console.log('-'.repeat(72));
  for (const k of keys) {
    const m = k.metadata || {};
    const flags = (m.flags || []).join(', ');
    console.log(
      `${String(m.reference || '?').padEnd(20)} ${String(m.received_at || '?').padEnd(26)} ${flags || '—'}`
    );
  }
  console.log(`\n${keys.length} shown. Read one with:  node tools/intake.mjs read <reference>`);
}

/* ------------------------------------------------------------------- read */

async function read(args) {
  let key = flag(args, '--key');
  const ref = args.find((a) => !a.startsWith('--'));

  if (!key) {
    if (!ref) throw new Error('Give a reference: node tools/intake.mjs read URE-260921-K4MQ');
    const all = JSON.parse(wrangler(['kv', 'key', 'list', '--binding=INTAKE', '--remote']));
    const hits = all.filter((k) => k.name.endsWith(':' + ref));
    if (!hits.length) throw new Error(`No submission found with reference ${ref}.`);
    key = hits[0].name;
  }

  const sealed = JSON.parse(wrangler(['kv', 'key', 'get', key, '--binding=INTAKE', '--remote']));
  print(open(sealed, privateKey()));
}

/* ---------------------------------------------------------------- decrypt */

async function decrypt(args) {
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) throw new Error('Give a file: node tools/intake.mjs decrypt record.json');
  print(open(JSON.parse(fs.readFileSync(file, 'utf8')), privateKey()));
}

/* ------------------------------------------------------------------ crypto */

function open(sealed, pem) {
  if (!sealed || sealed.v !== 1) throw new Error('Not an intake record, or a version this tool does not know.');

  const aesKey = crypto.privateDecrypt(
    { key: pem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(sealed.key, 'base64')
  );

  const ct = Buffer.from(sealed.ct, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', aesKey, Buffer.from(sealed.iv, 'base64'));
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);

  return JSON.parse(plain.toString('utf8'));
}

function privateKey() {
  const p = process.env.INTAKE_PRIVATE_KEY || path.resolve('intake-private-key.pem');
  if (!fs.existsSync(p)) {
    throw new Error(
      `No private key at ${p}.\n` +
        `Set INTAKE_PRIVATE_KEY to its path, or run  node tools/intake.mjs keygen  if you have not made one yet.`
    );
  }
  return fs.readFileSync(p, 'utf8');
}

/* ------------------------------------------------------------------- utils */

function wrangler(args) {
  try {
    return execFileSync('npx', ['wrangler', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  } catch {
    throw new Error('wrangler failed. Run this from the worker/ directory, and check `npx wrangler whoami`.');
  }
}

function flag(args, name) {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
}

function print(r) {
  const c = r.consent;
  const line = (k, v) => console.log(`  ${(k + ':').padEnd(22)}${v === '' || v == null ? '—' : v}`);

  console.log(`\n${r.reference}   received ${r.received_at}`);
  if (r.flags && r.flags.length) console.log(`  FLAGS: ${r.flags.join(', ')}`);

  console.log('\nLead');
  line('Name', r.lead.name);
  line('Property address', r.lead.property_address);
  line('Phone', r.lead.phone);
  line('Email', r.lead.email);
  line('Notes', r.lead.notes);

  console.log('\nConsent — Terms of Service and Privacy Policy');
  line('Accepted at', c.terms.accepted_at);
  line('Matches published', c.terms.matches_published_text);
  line('SHA-256 of text', c.terms.text_sha256);
  console.log(`\n  Exact text as rendered on the page:\n`);
  console.log(wrap(c.terms.text_as_rendered, 4));

  console.log('\nConsent — SMS');
  if (!c.sms.accepted) {
    line('Given', 'no');
  } else {
    line('Accepted at', c.sms.accepted_at);
    line('Matches published', c.sms.matches_published_text);
    line('SHA-256 of text', c.sms.text_sha256);
    console.log(`\n  Exact text as rendered on the page:\n`);
    console.log(wrap(c.sms.text_as_rendered, 4));
  }

  console.log('\nOriginating connection (recorded by the endpoint)');
  line('IP address', r.origin_record.ip);
  line('Country', r.origin_record.ip_country);
  line('Cloudflare ray', r.origin_record.cf_ray);
  line('TLS', r.origin_record.tls_version);

  console.log('\nReported by the browser (not independently verified)');
  line('Page URL', r.client_record.page_url);
  line('User agent', r.client_record.user_agent);
  line('Form loaded at', r.client_record.form_loaded_at);
  line('Submitted at', r.client_record.submitted_at);
  line('Time on page', Math.round(r.client_record.dwell_ms / 1000) + 's');
  line('Form version', r.form_version);
  console.log('');
}

function wrap(text, indent) {
  const pad = ' '.repeat(indent);
  const words = String(text || '').split(' ');
  const lines = [];
  let cur = pad;
  for (const w of words) {
    if (cur.length + w.length + 1 > 88) {
      lines.push(cur);
      cur = pad;
    }
    cur += (cur.trim() ? ' ' : '') + w;
  }
  lines.push(cur);
  return lines.join('\n');
}
