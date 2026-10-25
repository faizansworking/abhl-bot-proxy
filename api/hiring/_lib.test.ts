// Run: npm test  (plain node + assert; no test framework on purpose)
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { field, isToken, istClock, recipient, signatureOk, testUrl, timing, tokenFor } from './_lib.ts';

const SECRET = 'a-test-secret-1234567890';

// Signature: matches Tally's scheme, rejects tampering / missing header / no secret.
const body = JSON.stringify({ data: { fields: [{ key: 'k', label: 'Email', type: 'INPUT_EMAIL', value: 'A@x.com' }] } });
const sig = createHmac('sha256', SECRET).update(body).digest('base64');
assert.equal(await signatureOk(body, sig, SECRET), true);
assert.equal(await signatureOk(body.replace('A@x', 'B@x'), sig, SECRET), false);
assert.equal(await signatureOk(body, null, SECRET), false);
assert.equal(await signatureOk(body, sig, ''), false);
// Pretty-printed raw body still verifies against Tally's JSON.stringify form.
assert.equal(await signatureOk(JSON.stringify(JSON.parse(body), null, 2), sig, SECRET), true);

// Token: stable per email (case/space-insensitive), unguessable shape, needs a secret.
const t1 = await tokenFor(' A@X.com ', SECRET);
assert.equal(t1, await tokenFor('a@x.com', SECRET));
assert.notEqual(t1, await tokenFor('b@x.com', SECRET));
assert.equal(isToken(t1), true);
assert.equal(isToken('../../etc'), false);
await assert.rejects(tokenFor('a@x.com', ''));

// Fields.
const p = JSON.parse(body);
assert.equal(field(p, { type: 'INPUT_EMAIL' }), 'A@x.com');
assert.equal(field(p, { label: 'email' }), 'A@x.com');
assert.equal(field(p, { type: 'HIDDEN_FIELDS', label: 't' }), '');

// Timing: 60 min is on time, 61 is late.
assert.deepEqual(timing('2026-10-25T10:00:00Z', '2026-10-25T11:00:00Z'), { minutes: 60, late: false });
assert.deepEqual(timing('2026-10-25T10:00:00Z', '2026-10-25T11:01:00Z'), { minutes: 61, late: true });

// IST clock + deadline link (10:05 UTC + 60 min = 4:35 pm IST).
assert.equal(istClock('2026-10-25T11:05:00Z'), '4:35 pm, 25 Oct (IST)');
assert.match(testUrl(t1, '2026-10-25T10:05:00Z'), /t=[a-f0-9]{32}&deadline=4%3A35\+pm/);

// Safety switch: never mails the real address unless HIRING_LIVE=true.
assert.deepEqual(recipient('c@x.com', { HIRING_TEST_TO: 'me@x.com' }), { to: 'me@x.com', tag: '[TEST → c@x.com] ' });
assert.deepEqual(recipient('c@x.com', { HIRING_LIVE: 'true' }), { to: 'c@x.com', tag: '' });
assert.throws(() => recipient('c@x.com', {}));

console.log('hiring selftest: all passed');
