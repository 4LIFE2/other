// Negative test — make sure the validator catches malformed sessions.
const fs   = require('fs');
const path = require('path');
const { createValidator } = require('../src/schema-validator.js');
const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'spec', 'schema.v1.json'), 'utf8'));
const validate = createValidator(schema);

const cases = [
  { name: 'missing schemaVersion', session: { id: 'sess_1', createdAt: 0, startUrl: 'https://x', actions: [] }, expect: /schemaVersion/ },
  { name: 'wrong schemaVersion', session: { schemaVersion: '0.9.0', id: 'sess_1', createdAt: 0, startUrl: 'https://x', actions: [] }, expect: /const/ },
  { name: 'bad action id prefix', session: {
      schemaVersion: '1.0.0', id: 'sess_1', createdAt: 0, startUrl: 'https://x',
      actions: [{ id: 'foo_1', type: 'click', timestamp: 0, url: 'https://x', frameId: 0 }]
    }, expect: /pattern/ },
  { name: 'bad action type', session: {
      schemaVersion: '1.0.0', id: 'sess_1', createdAt: 0, startUrl: 'https://x',
      actions: [{ id: 'act_1', type: 'wiggle', timestamp: 0, url: 'https://x', frameId: 0 }]
    }, expect: /enum/ }
];

let allPass = true;
for (const c of cases) {
  const { valid, errors } = validate(c.session);
  if (valid) { console.error('FAIL (expected invalid):', c.name); allPass = false; continue; }
  const msg = errors.map(e => e.message).join(' | ');
  if (!c.expect.test(msg)) {
    console.error('FAIL (wrong error):', c.name, '→', msg);
    allPass = false;
  } else {
    console.log('OK  rejected:', c.name);
  }
}

process.exit(allPass ? 0 : 1);
