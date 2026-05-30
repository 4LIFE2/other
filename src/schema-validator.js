// schema-validator.js — runtime validation for Interaction Recorder sessions
// against spec/schema.v1.json (JSON Schema draft-07, subset).
//
// Implementation note: this module is a hand-rolled draft-07 validator that
// supports the subset of features used by schema.v1.json (type, required,
// properties, enum, const, pattern, format=uri, minimum, $ref, items,
// additionalProperties, oneOf, definitions). The spec mentions ajv; bundling
// ajv requires npm/network access that this build environment lacks. The
// validator below is dependency-free and behaves like ajv for the schema we
// vendor. Drop-in replacement: createValidator(schema)(data) -> { valid, errors }.
//
// Usage:
//   import { validateSession } from './src/schema-validator.js';
//   const { valid, errors } = validateSession(session);
//
// Or, in non-module loaders (extension pages):
//   <script src="spec/schema.v1.json" type="application/json" id="schema"></script>
//   const schema = JSON.parse(document.getElementById('schema').textContent);
//   const { valid, errors } = createValidator(schema)(session);

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.SchemaValidator = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function isObject(x) { return x !== null && typeof x === 'object' && !Array.isArray(x); }

  function jsonType(x) {
    if (x === null) return 'null';
    if (Array.isArray(x)) return 'array';
    if (Number.isInteger(x)) return 'integer';
    if (typeof x === 'number') return 'number';
    return typeof x; // string, boolean, object, undefined
  }

  function typeMatches(value, expected) {
    if (Array.isArray(expected)) return expected.some(t => typeMatches(value, t));
    const t = jsonType(value);
    if (expected === 'number') return t === 'number' || t === 'integer';
    return t === expected;
  }

  function resolveRef(root, ref) {
    if (!ref.startsWith('#/')) throw new Error('only local $refs supported: ' + ref);
    const parts = ref.slice(2).split('/').map(p => p.replace(/~1/g, '/').replace(/~0/g, '~'));
    let cur = root;
    for (const p of parts) {
      if (cur == null) return undefined;
      cur = cur[p];
    }
    return cur;
  }

  // RFC3986-ish URI check (good enough for the schema's `format: "uri"` use).
  function isUri(s) {
    if (typeof s !== 'string') return false;
    return /^[a-zA-Z][a-zA-Z0-9+.\-]*:[^\s]*$/.test(s);
  }

  function deepEqual(a, b) {
    if (a === b) return true;
    if (typeof a !== typeof b) return false;
    if (a === null || b === null) return a === b;
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false;
      return a.every((x, i) => deepEqual(x, b[i]));
    }
    if (isObject(a) && isObject(b)) {
      const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
      if (ka.length !== kb.length) return false;
      return ka.every((k, i) => k === kb[i] && deepEqual(a[k], b[k]));
    }
    return false;
  }

  function validate(rootSchema, schema, value, path, errors) {
    if (schema == null || typeof schema !== 'object') return;

    if (schema.$ref) {
      const target = resolveRef(rootSchema, schema.$ref);
      if (!target) {
        errors.push({ path, message: `unresolved $ref ${schema.$ref}` });
        return;
      }
      validate(rootSchema, target, value, path, errors);
      return;
    }

    if (schema.const !== undefined && !deepEqual(value, schema.const)) {
      errors.push({ path, message: `expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}` });
    }

    if (schema.enum !== undefined) {
      const ok = schema.enum.some(v => deepEqual(value, v));
      if (!ok) errors.push({ path, message: `value ${JSON.stringify(value)} not in enum ${JSON.stringify(schema.enum)}` });
    }

    if (schema.type !== undefined && !typeMatches(value, schema.type)) {
      errors.push({ path, message: `expected type ${JSON.stringify(schema.type)}, got ${jsonType(value)}` });
      return; // type mismatch — skip deeper checks
    }

    if (schema.oneOf) {
      let matches = 0;
      const subErrors = [];
      for (const sub of schema.oneOf) {
        const e = [];
        validate(rootSchema, sub, value, path, e);
        if (e.length === 0) matches += 1;
        else subErrors.push(e);
      }
      if (matches !== 1) {
        errors.push({ path, message: `oneOf matched ${matches} subschemas (expected 1)` });
      }
    }

    const t = jsonType(value);

    if (t === 'string') {
      if (schema.pattern !== undefined) {
        let rx;
        try { rx = new RegExp(schema.pattern); } catch (_) { rx = null; }
        if (rx && !rx.test(value)) {
          errors.push({ path, message: `string ${JSON.stringify(value)} does not match pattern ${schema.pattern}` });
        }
      }
      if (schema.format === 'uri' && !isUri(value)) {
        errors.push({ path, message: `string ${JSON.stringify(value)} is not a valid URI` });
      }
    }

    if (t === 'integer' || t === 'number') {
      if (schema.minimum !== undefined && value < schema.minimum) {
        errors.push({ path, message: `value ${value} < minimum ${schema.minimum}` });
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        errors.push({ path, message: `value ${value} > maximum ${schema.maximum}` });
      }
    }

    if (t === 'array') {
      if (schema.items) {
        for (let i = 0; i < value.length; i++) {
          validate(rootSchema, schema.items, value[i], path + '[' + i + ']', errors);
        }
      }
    }

    if (t === 'object') {
      if (Array.isArray(schema.required)) {
        for (const key of schema.required) {
          if (!Object.prototype.hasOwnProperty.call(value, key)) {
            errors.push({ path, message: `missing required property "${key}"` });
          }
        }
      }
      const props = schema.properties || {};
      for (const [k, sub] of Object.entries(props)) {
        if (Object.prototype.hasOwnProperty.call(value, k)) {
          validate(rootSchema, sub, value[k], path + '.' + k, errors);
        }
      }
      if (schema.additionalProperties !== undefined) {
        const ap = schema.additionalProperties;
        for (const k of Object.keys(value)) {
          if (Object.prototype.hasOwnProperty.call(props, k)) continue;
          if (ap === false) {
            errors.push({ path, message: `unexpected additional property "${k}"` });
          } else if (isObject(ap)) {
            validate(rootSchema, ap, value[k], path + '.' + k, errors);
          }
        }
      }
    }
  }

  function createValidator(schema) {
    return function (data) {
      const errors = [];
      validate(schema, schema, data, '$', errors);
      return { valid: errors.length === 0, errors };
    };
  }

  // Convenience: lazily-loaded validator bound to spec/schema.v1.json.
  let _bound = null;
  async function loadSchema() {
    if (_bound) return _bound;
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
      const url = chrome.runtime.getURL('spec/schema.v1.json');
      const res = await fetch(url);
      _bound = createValidator(await res.json());
      return _bound;
    }
    if (typeof fetch === 'function') {
      const res = await fetch('spec/schema.v1.json');
      _bound = createValidator(await res.json());
      return _bound;
    }
    throw new Error('no way to load spec/schema.v1.json in this environment');
  }

  async function validateSession(session) {
    const v = await loadSchema();
    return v(session);
  }

  return { createValidator, validateSession };
}));
