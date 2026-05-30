// Smoke test: build a synthetic v1.0.0 session matching what the extension emits
// and validate it against spec/schema.v1.json. Run with:  node test/validate-fixture.js
const fs   = require('fs');
const path = require('path');
const { createValidator } = require('../src/schema-validator.js');

const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'spec', 'schema.v1.json'), 'utf8'));
const validate = createValidator(schema);

// One representative action of each capture-time type.
const baseWaitObs = {
  msSinceLastAction: 1200,
  msSinceLastMutation: 600,
  domMutationsObservedSinceLastAction: 14,
  pendingNetworkRequests: 0,
  msSinceLastNetworkActivity: 800,
  wasNetworkIdle: true,
  wasDomStable: true
};

const submitSelectors = {
  primary: '[data-testid="submit-btn"]',
  alternatives: [
    { kind: 'testid', value: '[data-testid="submit-btn"]' },
    { kind: 'id',     value: '#submit-btn' },
    { kind: 'name',   value: 'button[name="submit"]' },
    { kind: 'aria',   value: 'button[aria-label="Sign in"]' },
    { kind: 'roleText', value: 'role=button & text="Sign in"' },
    { kind: 'css',    value: 'form#login > button:nth-of-type(1)' },
    { kind: 'xpath',  value: '/html/body/form/button' }
  ],
  xpath: '/html/body/form/button',
  textContent: 'Sign in',
  accessibleName: 'Sign in',
  tagName: 'button',
  attributes: {
    id: 'submit-btn',
    type: 'submit',
    'data-testid': 'submit-btn',
    'aria-label': 'Sign in'
  }
};

const iframeSelectors = {
  primary: '#payment-iframe',
  alternatives: [
    { kind: 'testid', value: '[data-testid="payment-frame"]' },
    { kind: 'id',     value: '#payment-iframe' },
    { kind: 'name',   value: 'iframe[name="pay"]' },
    { kind: 'css',    value: 'body > iframe:nth-of-type(1)' },
    { kind: 'xpath',  value: '/html/body/iframe' }
  ],
  xpath: '/html/body/iframe',
  textContent: '',
  accessibleName: '',
  tagName: 'iframe',
  attributes: { id: 'payment-iframe', name: 'pay', 'data-testid': 'payment-frame' }
};

const baseElement = {
  tagName: 'button', type: 'submit',
  innerText: 'Sign in',
  boundingRect: { x: 100, y: 240, width: 120, height: 36 },
  isVisible: true, computedRole: 'button',
  isContentEditable: false, valueSnapshot: null
};

const session = {
  schemaVersion: '1.0.0',
  id: 'sess_1730000000000',
  createdAt: 1730000000000,
  endedAt:   1730000123456,
  startUrl:  'https://example.com/login',
  userAgent: 'Mozilla/5.0 (test)',
  viewport:  { width: 1920, height: 1080 },
  tabId: 42,
  actions: [
    {
      id: 'act_0001', type: 'frame:ready',
      timestamp: 1730000000100, url: 'https://example.com/login', title: 'Login',
      frameId: 0, framePath: [], selectors: null, element: null,
      waitBefore: baseWaitObs, annotations: { label: '', comment: '' }
    },
    {
      id: 'act_0002', type: 'click',
      timestamp: 1730000005000, url: 'https://example.com/login', title: 'Login',
      frameId: 0, framePath: [],
      selectors: submitSelectors, element: baseElement,
      waitBefore: baseWaitObs,
      annotations: { label: '', comment: '' },
      button: 0, modifiers: { ctrl: false, shift: false, alt: false, meta: false }
    },
    {
      id: 'act_0003', type: 'input',
      timestamp: 1730000006000, url: 'https://example.com/login', title: 'Login',
      frameId: 0, framePath: [],
      selectors: { ...submitSelectors, tagName: 'input', primary: '#email' },
      element: { ...baseElement, tagName: 'input', type: 'text', valueSnapshot: 'me@example.com' },
      waitBefore: baseWaitObs,
      annotations: { label: '', comment: '' },
      value: 'me@example.com', inputType: 'text'
    },
    {
      id: 'act_0004', type: 'submit',
      timestamp: 1730000007000, url: 'https://example.com/login', title: 'Login',
      frameId: 0, framePath: [], selectors: submitSelectors, element: baseElement,
      waitBefore: baseWaitObs, annotations: { label: '', comment: '' }
    },
    {
      id: 'act_0005', type: 'navigation:committed',
      timestamp: 1730000008000, url: 'https://example.com/dashboard', title: '',
      frameId: 0, framePath: [], selectors: null, element: null,
      waitBefore: baseWaitObs, annotations: { label: '', comment: '' },
      transitionType: 'form_submit'
    },
    {
      id: 'act_0006', type: 'navigation:spa',
      timestamp: 1730000009000, url: 'https://example.com/dashboard#tab=2', title: '',
      frameId: 0, framePath: [], selectors: null, element: null,
      waitBefore: baseWaitObs, annotations: { label: '', comment: '' },
      newUrl: 'https://example.com/dashboard#tab=2'
    },
    {
      id: 'act_0007', type: 'click',
      timestamp: 1730000010000, url: 'https://example.com/dashboard', title: '',
      frameId: 5, framePath: [iframeSelectors],
      selectors: { ...submitSelectors, primary: '#inner-btn' },
      element: baseElement, waitBefore: baseWaitObs, annotations: { label: '', comment: '' },
      button: 0, modifiers: { ctrl: false, shift: false, alt: false, meta: false }
    },
    {
      id: 'act_0008', type: 'download:started',
      timestamp: 1730000011000, url: 'https://example.com/export.csv', title: '',
      frameId: 0, framePath: [], selectors: null, element: null,
      waitBefore: baseWaitObs, annotations: { label: '', comment: '' },
      downloadInfo: { filename: 'export.csv', url: 'https://example.com/export.csv',
                      mimeType: 'text/csv', bytesTotal: 1234 }
    },
    {
      id: 'act_0009', type: 'keydown',
      timestamp: 1730000012000, url: 'https://example.com/dashboard', title: '',
      frameId: 0, framePath: [],
      selectors: submitSelectors, element: baseElement,
      waitBefore: baseWaitObs, annotations: { label: '', comment: '' },
      key: 'Enter', modifiers: { ctrl: false, shift: false, alt: false, meta: false }
    }
  ]
};

const { valid, errors } = validate(session);
if (valid) {
  console.log('OK: synthetic session validates against schema.v1.json');
  process.exit(0);
} else {
  console.error('FAIL:');
  for (const e of errors) console.error('  ' + e.path + ': ' + e.message);
  process.exit(1);
}
