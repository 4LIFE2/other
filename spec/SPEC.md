# Interaction Recorder — v1 Specification

- **Status:** Approved for implementation
- **Schema version:** 1.0.0
- **Target:** Chrome MV3 extension + Node codegen utility
- **Source of truth for:** Claude Code handoff, future contributors, replay engine behavior

---

## 0. How to use this document

Three audiences:

- **Implementer (Claude Code):** Section 11 contains phase-by-phase tickets. Each phase is self-contained — files to create, files to modify, acceptance criteria. Sections 3–10 are the contract phases reference.
- **Operator (Mathyus):** Sections 8, 9, and 12 describe runtime behavior, configuration, and operational gotchas. Section 13 lists what won't work yet.
- **Future contributor:** Sections 1–2 explain the *why*. Section 14 is the glossary.

Decisions in this doc are decisions, not options. Where a real tradeoff exists, the chosen path is stated and the alternative is noted as a comment so we don't relitigate it.

---

## 1. Goals and non-goals

### Goals

1. Record any sequence of clicks, inputs, navigations, and downloads on any website that runs in Chrome
2. Produce a structured, replayable artifact that captures **intent**, not just raw events
3. Replay reliably even when the page is slow, partially loaded, or has minor DOM changes since recording
4. Support parameterization (run the same flow with N different inputs) and loops (iterate over a list of inputs)
5. Extract data from pages during replay and emit it as structured output
6. Codegen to Playwright (Python) and n8n workflows for handoff to other automation systems

### Non-goals (v1)

- Cross-browser support (Firefox, Safari)
- Mobile browser recording
- Visual regression testing
- Full recording inside Shadow DOM (best-effort only)
- Drag-and-drop as a discrete drag sequence (captured as click only)
- Native OS dialog contents (file picker selections, print dialogs)
- Multi-tab orchestration (a recording targets one tab; v2 may add tab arrays)

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          Chrome MV3 Extension                           │
│                                                                         │
│   ┌──────────────┐   ┌─────────────────┐   ┌──────────────────────┐    │
│   │ popup.html   │   │ editor.html     │   │ replayer.html        │    │
│   │ (record UI)  │   │ (compile UI)    │   │ (run + report UI)    │    │
│   └──────┬───────┘   └────────┬────────┘   └──────────┬───────────┘    │
│          │                    │                       │                 │
│          └────────────┬───────┴───────────────────────┘                 │
│                       │ chrome.runtime.sendMessage                      │
│                       ▼                                                 │
│             ┌─────────────────────────┐                                 │
│             │     background.js       │                                 │
│             │     (service worker)    │                                 │
│             │  - session state        │                                 │
│             │  - chrome.storage I/O   │                                 │
│             │  - chrome.webRequest    │                                 │
│             │  - chrome.webNavigation │                                 │
│             │  - chrome.downloads     │                                 │
│             │  - replay coordinator   │                                 │
│             └───────────┬─────────────┘                                 │
│                         │ chrome.tabs.sendMessage / scripting           │
│                         ▼                                               │
│             ┌─────────────────────────┐                                 │
│             │     content.js          │                                 │
│             │     (every frame)       │                                 │
│             │  - DOM event capture    │                                 │
│             │  - selector engine      │                                 │
│             │  - mutation observer    │                                 │
│             │  - replay executor      │                                 │
│             └─────────────────────────┘                                 │
└─────────────────────────────────────────────────────────────────────────┘
```

**Hard rules:**
- The service worker is the **single source of truth** for session state. Pages and content scripts are clients.
- The content script is dumb: it captures or executes when told. It never decides on its own.
- Cross-frame messaging always goes through the service worker — content scripts in different frames never talk directly.

---

## 3. Schema v1.0.0

Two artifact types live in this system:

| Artifact | File suffix | Produced by | Consumed by |
|----------|-------------|-------------|-------------|
| **Raw recording** | `.rec.json` | Capture (popup → content) | Editor |
| **Compiled recording** | `.cr.json` | Editor (with parameters/loops/extractions added) | Playback engine, codegen |

A raw recording is a flat list of observed actions. A compiled recording is a raw recording **plus** declared parameters, loop boundaries, conditional steps, and extractions. The schema below covers both — fields used only at compile time are marked `(compiled only)`.

### 3.1 Session envelope

```jsonc
{
  "schemaVersion": "1.0.0",
  "id": "sess_1730000000000",
  "name": "Daily ChatGPT export",            // (compiled only) human-friendly
  "description": "Iterates conversations...", // (compiled only) optional
  "createdAt": 1730000000000,
  "endedAt":   1730000123456,
  "startUrl": "https://chatgpt.com/",
  "userAgent": "Mozilla/5.0 ...",
  "viewport": { "width": 1920, "height": 1080 },
  "tabId": 42,                                // raw only; not used at replay
  "parameters": [ /* §3.6 */ ],               // (compiled only)
  "loops":      [ /* §3.7 */ ],               // (compiled only)
  "extractions":[ /* §3.8 */ ],               // (compiled only)
  "actions":    [ /* §3.2 */ ],
  "config": { /* §12 — overrides for this recording */ }
}
```

### 3.2 Action — common fields

Every action has these fields:

```jsonc
{
  "id": "act_001",                  // stable, unique within session
  "type": "click",                  // see §3.2.1 for enum
  "timestamp": 1730000005000,       // ms since epoch, capture time
  "url": "https://...",             // url when action occurred
  "title": "Page Title",
  "frameId": 0,                     // 0 = top frame
  "framePath": [],                  // §3.2.2 — for nested iframes
  "selectors": { /* §3.3 */ },
  "element":   { /* §3.4 */ },
  "waitBefore":{ /* §3.5 */ },      // observations from capture
  "waitPolicy":{ /* §5 */ },        // (compiled only) replay rules
  "condition": { /* §3.9 */ },      // (compiled only) optional
  "loopRef":   "loop_1",            // (compiled only) which loop
  "parameterRefs": [],              // (compiled only) which params resolve into this action
  "annotations": { "label": "click submit", "comment": "" }
}
```

#### 3.2.1 Action type enum

| Type | Captured | Replayed | Notes |
|---|---|---|---|
| `click`                | yes | yes | Records button, modifiers |
| `dblclick`             | yes | yes | If `detail >= 2` on the click event |
| `input`                | yes | yes | Debounced text input — final value only |
| `change`               | yes | yes | For checkboxes, radios, selects |
| `submit`               | yes | yes | Form submission |
| `keydown`              | yes | yes | Special keys only (Enter, Tab, Esc, arrows, modifiers) |
| `navigation:committed` | yes | implicit | Top-frame full page nav (background-tracked) |
| `navigation:spa`       | yes | implicit | pushState / replaceState / hashchange |
| `frame:ready`          | yes | no  | Marker — frame loaded, listener attached |
| `download:started`     | yes | yes | A download was initiated (background-tracked via chrome.downloads) |
| `extract`              | no  | yes | (compiled only) §3.8 |
| `wait`                 | no  | yes | (compiled only) explicit wait inserted in editor |
| `assert`               | no  | yes | (compiled only) check that something is true |

Navigations are **observed** at capture but **inferred** at replay — the engine doesn't actively navigate; it expects the action it just performed to cause the navigation, and waits for it.

#### 3.2.2 framePath

For an action inside a nested iframe, `framePath` is the array of selectors needed to walk from the top frame to the action's frame:

```json
"framePath": [
  { "primary": "iframe#payment-iframe", "alternatives": ["iframe[name=\"pay\"]"] }
]
```

Empty array = top frame. Each selector bundle in the array is a §3.3 bundle.

### 3.3 Selector bundle

A ranked list of selector strategies. Capture picks the best `primary`; replay tries `primary` first, then walks `alternatives` in order, then synthesizes from `xpath` / `textContent` / `attributes` if all fail.

```jsonc
{
  "primary": "[data-testid=\"submit-btn\"]",
  "alternatives": [
    { "kind": "testid",  "value": "[data-testid=\"submit-btn\"]" },
    { "kind": "id",      "value": "#submit" },
    { "kind": "name",    "value": "button[name=\"submit\"]" },
    { "kind": "aria",    "value": "button[aria-label=\"Sign in\"]" },
    { "kind": "roleText","value": "role=button & text=\"Sign in\"" },
    { "kind": "css",     "value": "form > div:nth-of-type(2) > button" }
  ],
  "xpath": "/html/body/form/div[2]/button",
  "textContent": "Sign in",
  "accessibleName": "Sign in",
  "tagName": "button",
  "attributes": {
    "type": "submit",
    "data-testid": "submit-btn",
    "class": "btn btn-primary"
  }
}
```

**Strategy rank (capture-time `primary` selection):**
1. `testid` — `data-testid`, `data-test`, `data-cy`, `data-qa`, `data-test-id` if unique
2. `id` — if unique and not auto-generated (see §6)
3. `name` — `<input name>`, `<form name>` if unique
4. `aria` — `aria-label` if unique
5. `roleText` — accessibility role + accessible name (Playwright-style)
6. `css` — full CSS path with `:nth-of-type` (always present)
7. `xpath` — absolute XPath (always present, last resort)

A strategy is included in `alternatives` only if its selector resolves to **exactly one element** at capture time. CSS path and XPath are always present.

### 3.4 Element snapshot

Used for replay diagnostics, healing, and codegen comments:

```jsonc
{
  "tagName": "button",
  "type": "submit",
  "innerText": "Sign in",
  "boundingRect": { "x": 100, "y": 240, "width": 120, "height": 36 },
  "isVisible": true,
  "computedRole": "button",
  "isContentEditable": false,
  "valueSnapshot": null
}
```

`valueSnapshot` is `null` for non-input elements; for inputs, the value at the moment the event fired (with `<<password>>` masking).

### 3.5 Wait observations (capture-time)

What was true on the page **just before** this action. Used by Phase 5 to build replay wait policies, and by the editor to suggest sensible defaults.

```jsonc
{
  "msSinceLastAction": 2400,
  "msSinceLastMutation": 720,
  "domMutationsObservedSinceLastAction": 18,
  "pendingNetworkRequests": 0,
  "msSinceLastNetworkActivity": 1200,
  "wasNetworkIdle": true,
  "wasDomStable": true
}
```

`wasDomStable` = true if `msSinceLastMutation >= config.domStableThresholdMs`.
`wasNetworkIdle` = true if `pendingNetworkRequests === 0` AND `msSinceLastNetworkActivity >= config.networkIdleThresholdMs`.

### 3.6 Parameters (compiled only)

A parameter is a named placeholder that replaces a captured value at run time.

```jsonc
{
  "name": "search_keyword",
  "type": "string",                 // string | number | boolean | array<string>
  "source": "input",                // input | csv | json | env | extraction
  "sourceConfig": {
    "promptLabel": "Search keyword",
    "default": "AI",
    "secret": false                 // true = treat like a password in logs/UI
  },
  "description": "Term to search for in the dashboard"
}
```

Actions reference parameters in their `value` field with `{{name}}` syntax:

```json
{ "type": "input", "value": "{{search_keyword}}", "selectors": { "...": "..." } }
```

Compile-time validation: every `{{name}}` referenced anywhere must exist in `parameters[]`.

### 3.7 Loops (compiled only)

A loop wraps a contiguous range of actions and iterates over an array parameter.

```jsonc
{
  "id": "loop_1",
  "name": "Process each keyword",
  "iterates": "search_keywords",     // must be a parameter of type array<*>
  "itemAlias": "keyword",            // each iteration's value referenced as {{keyword}}
  "indexAlias": "i",                 // 0-based loop index, referenced as {{i}}
  "startActionId": "act_007",
  "endActionId":   "act_014",
  "onError": "continue"              // continue | abort | retry-once
}
```

**Constraints:**
- v1: linear iteration only, no parallelism
- v1: no nested loops (one loop per session). v2 will lift this.
- Actions inside `[startActionId, endActionId]` get `loopRef: "loop_1"` set
- Extractions inside a loop produce an array of length `iterations`

### 3.8 Extractions (compiled only)

An extraction captures data from the page during replay instead of interacting with it.

```jsonc
{
  "id": "ext_1",
  "actionId": "act_010",             // the synthetic extract action this represents
  "name": "conversation_title",
  "selectors": { /* §3.3 */ },
  "extract": "text",                 // text | innerHTML | attribute:href | attribute:src | value | boundingRect
  "storeAs": "conversation_titles",  // bare name for top-level; appended to array if inside loop
  "missingPolicy": "null"            // null | skip-iteration | fail
}
```

The `extract` action type appears in `actions[]` like any other; the `extractions[]` array is just a registry that gives them human names and output structure.

**Output of a run:** see §9.5.

### 3.9 Conditions (compiled only)

A condition gates a single action. The action runs only if the condition evaluates true.

```jsonc
{
  "type": "selectorExists",          // selectorExists | selectorMissing | urlMatches | textPresent | previousActionStatus
  "selector": { /* §3.3 */ },        // for selector-* conditions
  "urlPattern": "^https://.*/done",  // for urlMatches (regex)
  "text": "Export ready",            // for textPresent
  "previousActionId": "act_009",     // for previousActionStatus
  "expectedStatus": "success",       // for previousActionStatus
  "ifFalse": "skip"                  // skip | abort
}
```

Only one condition per action. (Compose with explicit `assert` actions if you need more logic.)

---

## 4. Capture rules

What the content script translates DOM events into. These rules are normative — Phase 2 must match them exactly.

### 4.1 Click

- Source event: `click` in capture phase on `document`
- Captured: target element, button (0/1/2), modifier keys, `detail` (becomes `dblclick` if ≥2)
- **Suppressed:** clicks on `<option>` inside `<select>` — those produce a `change` event and that's what we want
- **Suppressed:** synthetic clicks dispatched by JS (`event.isTrusted === false`)

### 4.2 Input (typing)

- Source event: `input` on `document`, capture phase
- Buffered per-element. After 600ms with no further input on the same element, emit one `input` action with the **final** value.
- Password fields (`type="password"`) emit `<<password>>` as the value, never the actual text
- The buffer flushes immediately on blur, on form submit, and on stop-recording

### 4.3 Change

- Source event: `change` on `document`, capture phase
- Use for: checkboxes, radios, `<select>`, `<input type="file">` (the click event), date pickers
- **Not** used for text input — that goes through 4.2

### 4.4 Submit

- Source event: `submit` on `document`, capture phase
- Captures the form element. Often redundant with a click on the submit button — both are recorded; editor can dedupe.

### 4.5 Keydown

- Source event: `keydown` on `document`, capture phase
- Captured **only if** key is in `["Enter","Escape","Tab","ArrowUp","ArrowDown","ArrowLeft","ArrowRight","Backspace","Delete","Home","End","PageUp","PageDown"]` OR a modifier is held (Ctrl, Meta, Alt)
- Plain alphanumeric keystrokes are not recorded — they're already captured by §4.2

### 4.6 Navigation — full page

- Source: `chrome.webNavigation.onCommitted` for `frameId === 0` of the recorded tab
- Emits `navigation:committed` action with `transitionType` from the API

### 4.7 Navigation — SPA

- Source: monkey-patched `history.pushState` / `history.replaceState` plus `popstate` and `hashchange` events in content script
- Emits `navigation:spa` with the new URL

### 4.8 Download

- Source: `chrome.downloads.onCreated` while a recording is active and the initiating tab matches
- Emits `download:started` with `filename`, `url`, `mimeType`, `bytesTotal`
- The action's `selectors` are null — downloads are tab-level events, not element events
- The previous action (usually a click) is the cause; replay uses *previous click* + *wait for download* as the pattern

### 4.9 Network observation

Background script subscribes to `chrome.webRequest.onBeforeRequest` and `onCompleted` for the recorded tab.

It maintains, per tab:
- `pendingRequestsCount` — current in-flight requests
- `lastNetworkActivityAt` — timestamp of most recent request start or completion
- A small ring buffer of recent request URLs (last 50, for debugging only)

When an action is recorded, the content script asks background for these values and embeds them into `waitBefore` (§3.5).

**Long-polling / SSE handling:** any request whose response has `Content-Type` starting with `text/event-stream` OR remains in-flight for more than `config.longPollThresholdMs` (default 8000ms) is **excluded** from `pendingRequestsCount` going forward. This prevents persistent connections from making the page look "never idle."

### 4.10 Frame handling

- Content script runs in `all_frames: true` at `document_start`
- Each frame independently sends actions to background
- Background tags each incoming action with `frameId` (from sender) and walks the frame tree to compute `framePath`
- Cross-origin frames: actions are still captured; `framePath` selectors target the frame element from the parent's perspective, which is what replay needs

### 4.11 Shadow DOM (best effort)

- For shadow roots whose host is reachable from `document`, walk into the root via `event.composedPath()` to find the actual target
- Selectors include the host's selector + a synthetic `>>` separator + the inner element's selector, e.g. `my-component >> button.primary`
- Replay must support this `>>` shadow-piercing syntax (Phase 5)
- Closed shadow roots: cannot be pierced. Action is recorded against the host; selectors only reach the host.

---

## 5. Wait & retry policy at replay

The replay engine evaluates these conditions **in order** before dispatching each action.

### 5.1 Per-action wait policy (compiled-only field)

```jsonc
"waitPolicy": {
  "preNavigation": {
    "waitForUrlPattern": "^https://chatgpt.com/c/.*",  // optional regex
    "timeoutMs": 10000
  },
  "preTarget": {
    "waitForSelector": true,                           // default: true
    "requireUnique": true,                             // default: true
    "timeoutMs": 30000
  },
  "preStability": {
    "domStable": true,                                 // default: from waitBefore.wasDomStable
    "domStableMs": 500,
    "networkIdle": false,                              // default: from waitBefore.wasNetworkIdle, but off for known long-pollers
    "networkIdleMs": 500
  },
  "postAction": {
    "waitForSelector": null,                           // optional success selector
    "waitForUrlChange": false,                         // true if action should cause nav
    "waitForDownload": false,                          // true for download:started causes
    "minDelayMs": 100,                                 // floor — give the page a tick
    "timeoutMs": 30000
  },
  "retries": {
    "max": 3,
    "backoffMs": [500, 1000, 2000],
    "onTotalFailure": "fail"                          // fail | skip | prompt
  }
}
```

### 5.2 Default policy generation

When the editor compiles a raw recording, it generates `waitPolicy` from `waitBefore` using these rules:

| Observed at capture | Default policy |
|---|---|
| `wasDomStable` true, no nav | `preStability.domStable: true`, `postAction.minDelayMs: 100` |
| `wasNetworkIdle` true | `preStability.networkIdle: true` |
| Action followed by `navigation:committed` within 5s | `postAction.waitForUrlChange: true` |
| Action followed by `navigation:spa` within 2s | `postAction.waitForUrlChange: true` (SPA URL counts) |
| Action followed by `download:started` within 30s | `postAction.waitForDownload: true` |
| `pendingRequestsCount > 0` at capture, count went to 0 within 10s | `preStability.networkIdle: true`, `networkIdleMs: 1000` |
| msSinceLastAction > 5000 (user thought) | `preTarget.timeoutMs: 60000` (extra patient) |

The operator can override any of these in the editor.

### 5.3 Replay execution loop (per action)

```
1. If condition exists (§3.9), evaluate it.
   - If false and ifFalse=skip → mark step skipped, move on
   - If false and ifFalse=abort → fail run

2. preNavigation: if waitForUrlPattern set, wait until current URL matches OR timeout.
   - Timeout → enter retry loop (§5.4)

3. preTarget: resolve selectors (§6).
   - First selector that resolves uniquely wins.
   - None resolve → enter retry loop.

4. preStability:
   - If domStable: poll mutation observer; wait until no mutations for domStableMs.
   - If networkIdle: poll background's pendingRequestsCount until 0 for networkIdleMs.
   - Either condition's timeout = preTarget.timeoutMs (shared budget).

5. Dispatch the action against the resolved element.
   - Click: scroll into view, then synthesize click via element.click() AND a real
     dispatchEvent('click', {bubbles, cancelable, composed, isTrusted: false-ish}).
     For React/Vue, prefer the native click. See §9.2 for input dispatch quirks.

6. postAction:
   - Always wait minDelayMs (default 100).
   - If waitForUrlChange: wait until URL differs from pre-action URL.
   - If waitForDownload: wait for chrome.downloads.onCreated event.
   - If waitForSelector: wait for that selector to resolve.
   - Each with its own timeout (postAction.timeoutMs).

7. Mark step success. Continue.
```

### 5.4 Retry loop

When a step fails any of preNavigation / preTarget / preStability / postAction:

```
attempt = 1
while attempt <= retries.max:
    sleep(retries.backoffMs[attempt - 1])
    re-resolve selectors (selector healing — §6.3)
    re-run from step 2 in §5.3
    if success → break, log which selector/attempt worked
    attempt++

if all attempts exhausted:
    apply retries.onTotalFailure:
      - fail   → mark run failed, stop
      - skip   → mark step skipped, continue to next action
      - prompt → pause; user decides via replayer UI (continue / skip / abort)
```

### 5.5 Loop iteration

For an action inside a loop:
- The loop's `onError` setting **overrides** the action's `retries.onTotalFailure` for the final outcome:
  - `loop.onError = "continue"` → on step failure, abandon this iteration, start next
  - `loop.onError = "abort"` → on step failure, abort whole run
  - `loop.onError = "retry-once"` → restart the iteration from `startActionId` once; on second failure, behave like `continue`

---

## 6. Selector resolution & healing

### 6.1 Resolution algorithm at replay

Given a selector bundle:

```
1. Try primary as a CSS selector. If document.querySelectorAll(primary).length === 1 → win.
2. For each entry in alternatives (in order):
   - kind=css | id | name | aria | testid: try as CSS
   - kind=roleText: use accessibility tree walk (§6.2)
3. Try xpath via document.evaluate. If exactly one result → win.
4. Last resort: text+tag fuzzy match — find all elements with tagName matching
   `tagName` whose normalized innerText contains `textContent` (case-insensitive).
   If exactly one → win, log "fuzzy-text fallback used".
5. None match → return null. Caller (replay loop) handles retry.
```

Selectors are evaluated against the correct frame — the engine first walks `framePath` to reach the right document.

### 6.2 Role + accessible name resolution

For `roleText` strategy, walk the accessibility tree:

```js
const all = document.querySelectorAll('*');
const matches = [...all].filter(el => {
  const role = el.getAttribute('role') || implicitRole(el.tagName);
  if (role !== expectedRole) return false;
  const name = el.getAttribute('aria-label')
            || el.getAttribute('aria-labelledby')
            || el.innerText
            || el.value
            || '';
  return name.trim() === expectedName;
});
if (matches.length === 1) return matches[0];
```

Implicit role table covers the common ones: `button` for `<button>`, `link` for `<a href>`, `textbox` for `<input type=text>`, etc. Phase 5 ships a minimal mapping; Phase 6 expands.

### 6.3 Selector healing

When `primary` fails but an alternative wins, log the event:

```jsonc
{
  "type": "selector_healed",
  "actionId": "act_005",
  "originalPrimary": "[data-testid=\"submit-btn\"]",
  "healedWith": { "kind": "roleText", "value": "role=button & text=\"Sign in\"" },
  "attemptNumber": 2
}
```

After a successful run, the replayer offers: *"3 selectors were healed during this run. Update recording to use the healed selectors as primary?"* — opt-in, never automatic.

### 6.4 Auto-generated ID detection

Many SPAs generate IDs like `mui-3-input-7`. These are unstable. When picking `primary` at capture time, **reject** an `id` selector if the id matches:

```regex
^(mui-|emotion-|radix-|chakra-|css-|MuiBox-|sc-)
^[a-z0-9]{6,}-[a-z0-9]{6,}$         (looks like a hash)
^:r[0-9a-z]+:$                       (React useId)
```

Such IDs are still recorded in `attributes` (useful debugging info) but won't be promoted to `primary`.

---

## 7. Frame & shadow DOM handling

Already covered in §4.10–4.11 and §6.1. Summary:

- **iframes:** content script in every frame; actions tagged with `framePath`; replay walks the path before resolving.
- **Cross-origin iframes:** captured normally from inside the frame; replay walks across via the parent's selector to the iframe element.
- **Open shadow DOM:** pierced via `composedPath()` at capture; selectors use `>>` separator; replay engine supports the syntax.
- **Closed shadow DOM:** unsupported; recorded as host-level interaction.

---

## 8. Editor

A page at `chrome-extension://<id>/editor.html` that loads a `.rec.json` file (or the most recent capture from storage) and produces a `.cr.json`.

### 8.1 Required functionality

1. **Load** — pick raw recording from session list, or upload from disk
2. **Action list** — table view: timestamp, type, target description, value, status indicator
3. **Inspect** — click any action to see full selector bundle, element snapshot, wait observations
4. **Annotate** — give an action a human-readable label and comment
5. **Delete** — remove junk steps (duplicate clicks, accidental scrolls)
6. **Reorder** — drag-and-drop to reorder
7. **Insert** — add `wait`, `assert`, or `extract` actions between existing ones
8. **Mark as parameter** — turn a captured value into `{{paramName}}`. UI: click the value, choose "Make this a parameter," enter name and source. Adds entry to `parameters[]` and replaces value across all actions where it appears.
9. **Define loop** — select a contiguous range of actions, set the `iterates` parameter, name the loop
10. **Define extraction** — for any element-targeting action, convert to `extract` type and pick what to extract
11. **Generate wait policies** — auto-generate `waitPolicy` for all actions per §5.2 rules. Operator can edit per-action.
12. **Validate & save** — run schema validation (§3) and parameter reference checks; on success, save as `.cr.json` to chrome.storage and offer download

### 8.2 UI minimum (Phase 4)

Phase 4 ships a functional editor — not a polished one. Requirements:
- Two-column: action list left, inspector right
- Edit fields (label, comment, value) directly in inspector
- Buttons for delete/reorder/parameterize/loop/extract
- "Compile" button runs validation and produces `.cr.json`

Phase 6 polishes (drag-and-drop reorder, undo/redo, side-by-side diff against previous compile).

---

## 9. Playback engine

Lives at `chrome-extension://<id>/replayer.html` with execution logic in `background.js` and `content.js`.

### 9.1 Run lifecycle

```
1. User picks a .cr.json
2. UI shows declared parameters; prompts for values where source=input
3. User clicks "Run"
4. Background script:
   a. Opens or focuses target tab
   b. Navigates to startUrl (unless already there per param)
   c. Sends "replay:execute_action" to content.js for each action in order
   d. For loops: iterates the array param, executing the bracketed actions per item
   e. Collects extraction outputs
   f. Streams per-step status to replayer.html for live display
5. Run completes (success / failed / aborted)
6. Generate run report (§9.5) and offer download
```

### 9.2 Action dispatch in content.js

For maximum compatibility with React/Vue/Angular controlled inputs:

**Click:**
```js
element.scrollIntoView({ block: 'center' });
element.focus();
element.click();   // synchronous, triggers framework handlers
```

**Input (text):**
```js
const setter = Object.getOwnPropertyDescriptor(
  element.constructor.prototype, 'value'
).set;
setter.call(element, newValue);
element.dispatchEvent(new Event('input', { bubbles: true }));
element.dispatchEvent(new Event('change', { bubbles: true }));
```

The native-setter trick is mandatory for React. *Alternative — sending raw keystrokes via chrome.debugger — rejected for v1: too heavyweight, requires debugger permission, alarms the user.*

**Change (checkbox/radio):**
```js
element.checked = newChecked;
element.dispatchEvent(new Event('change', { bubbles: true }));
```

**Change (select):**
```js
element.value = newValue;
element.dispatchEvent(new Event('change', { bubbles: true }));
```

**Keydown (special keys):**
```js
element.dispatchEvent(new KeyboardEvent('keydown', {
  key, code: keyToCode(key), bubbles: true, cancelable: true,
  ctrlKey, shiftKey, altKey, metaKey
}));
```

Note: synthetic keydown won't trigger native form submission on Enter. For Enter in a form, dispatch keydown **and** call `form.requestSubmit()` if the element is inside a form.

### 9.3 Pausing & stepping

Replayer UI exposes:
- Pause / Resume
- Step (run one action then pause)
- Skip (don't run this action, move on)
- Abort

Live display: current action highlighted; per-step status (pending / running / ok / failed / skipped).

### 9.4 Run report

```jsonc
{
  "runId": "run_1730000999",
  "recordingId": "sess_1730000000000",
  "startedAt": 1730000999000,
  "endedAt":   1730001050000,
  "status": "success",                 // success | failed | aborted | partial
  "parameters": { "search_keyword": "AI" },
  "steps": [
    {
      "actionId": "act_001",
      "status": "success",
      "durationMs": 240,
      "selectorUsed": "[data-testid=\"submit-btn\"]",
      "selectorHealed": false,
      "retries": 0,
      "logs": []
    },
    {
      "actionId": "act_005",
      "status": "success",
      "selectorUsed": "role=button & text=\"Sign in\"",
      "selectorHealed": true,
      "originalPrimary": "[data-testid=\"submit-btn\"]",
      "retries": 1,
      "logs": ["primary failed: 0 matches", "healed via roleText"]
    }
  ],
  "loopIterations": [
    { "loopId": "loop_1", "index": 0, "item": "AI", "status": "success" },
    { "loopId": "loop_1", "index": 1, "item": "ML", "status": "failed", "failedActionId": "act_010" }
  ],
  "extractions": {
    "conversation_titles": ["First chat", "Second chat", "Third chat"]
  },
  "screenshots": []                    // populated only if config.captureScreenshotsOnError
}
```

### 9.5 Extraction output structure

Top-level (extraction outside any loop):
```json
"extractions": { "page_title": "Dashboard" }
```

Inside a loop:
```json
"extractions": {
  "conversation_titles": ["First chat", "Second chat", "Third chat"]
}
```

Multiple extractions inside the same loop produce parallel arrays of equal length:
```json
"extractions": {
  "conversation_titles": ["First chat", "Second chat"],
  "conversation_dates":  ["2026-04-01", "2026-04-15"]
}
```

If a `missingPolicy: "skip-iteration"` triggers in iteration N, **all** parallel arrays for that loop skip index N (they stay aligned).

---

## 10. Codegen

Phase 7. Three targets, one input (`.cr.json`).

### 10.1 Playwright (Python)

- One file per recording
- Parameters → function arguments
- Loops → for loops
- Selectors → Playwright locators in priority order: `get_by_role`, `get_by_test_id`, `get_by_label`, fallback to CSS
- Wait policies → built-in `wait_for_*` calls
- Extractions → return dict
- Comments preserve operator's `annotations.comment`

### 10.2 n8n workflow JSON

- Each action becomes an n8n node (HTTP, Code, Set, IF as needed)
- Loop = "Split In Batches" node
- Parameters = workflow inputs
- Browser steps use the **Playwright Community Node** if available, else generate a Code node that drives Playwright via subprocess

This target matches Mathyus's existing automation stack and is the highest-value codegen target.

### 10.3 Self-contained extension

A standalone Chrome extension (no recording UI) that hardcodes one specific recording and exposes a "Run" button. Useful for one-click sharing of a workflow with non-technical users. Lowest priority of the three.

---

## 11. Build phases — Claude Code tickets

Each phase below is a self-contained ticket. Claude Code can pick them up in order. Every phase ends with a working extension that can be tested end-to-end.

### Phase 1 — Schema lock & v0.1 conformance

**Goal:** v0.1 capture emits valid v1.0.0 schema. Editor and playback don't exist yet.

**Files to create:**
- `spec/schema.v1.json` — already provided, vendor it
- `src/types.ts` — already provided, vendor it
- `src/schema-validator.js` — runtime validation against schema.v1.json (use ajv, bundled)

**Files to modify:**
- `content.js` — emit `id` per action, emit `framePath`, emit complete `selectors` bundle with `kind`-tagged alternatives, reject auto-generated IDs per §6.4
- `background.js` — add `schemaVersion`, `userAgent`, `viewport` to session envelope; add `chrome.webRequest` listeners and maintain pending count + last activity per tab; embed wait observations into outgoing actions; subscribe to `chrome.downloads.onCreated`
- `manifest.json` — add `webRequest` permission

**Acceptance:**
- A recording session produces JSON that validates against `schema.v1.json`
- Every action has all fields from §3.2 (waitPolicy, condition, loopRef, parameterRefs may be absent — they're compiled-only)
- `framePath` correctly populated for an iframe interaction (test with the example iframe page in `test/fixtures/iframe.html`)
- Auto-generated MUI-style IDs do not appear as `primary`

**Test fixtures to ship:**
- `test/fixtures/simple-form.html` — login form, exercises click + input + submit
- `test/fixtures/iframe.html` — page with one iframe
- `test/fixtures/spa.html` — uses pushState, exercises navigation:spa

### Phase 2 — Capture enhancements

**Goal:** capture is rich enough to drive replay reliably.

**Files to modify:**
- `content.js` — add shadow DOM piercing per §4.11 with `>>` syntax
- `background.js` — long-poll/SSE detection per §4.9; download tracking emits `download:started` actions
- `popup.html/js` — checkbox: "Capture screenshots on each action" (off by default; phase 2 just stores them as base64 in actions, phase 6 moves to chrome.storage with action references)

**Acceptance:**
- Recording on a site with a shadow-DOM web component produces selectors with `>>` separators
- Recording on a site with a long-polling endpoint (test fixture: `test/fixtures/long-poll.html`) shows `pendingNetworkRequests` settling to 0 (the long-poll is excluded after threshold)
- Clicking a download link produces a `click` action followed by a `download:started` action

### Phase 3 — Editor v1 (functional, ugly OK)

**Goal:** turn raw recordings into compiled recordings.

**Files to create:**
- `editor.html`, `editor.js`, `editor.css`
- `src/compiler.js` — applies §5.2 default policies, validates parameter refs, validates loop ranges
- `manifest.json` — add `editor.html` as a web-accessible resource

**Files to modify:**
- `popup.html/js` — add "Open in Editor" button next to each saved session

**Acceptance per §8.1, items 1–11:**
- Can load any recording from storage
- Can rename/comment/delete/reorder actions
- Can mark a value as a parameter (single source: `input` is enough for Phase 3; `csv` lands in Phase 5)
- Can wrap a range of actions as a loop (loop param must already exist)
- Can convert an action to `extract`
- Can insert `wait` and `assert` actions
- "Compile" runs validation and saves a `.cr.json` to storage
- Compile errors show inline (which action, what's wrong)

### Phase 4 — Playback engine v1 (no params, no loops)

**Goal:** execute a compiled recording that has no parameters or loops. Validates the wait policy and selector resolution.

**Files to create:**
- `replayer.html`, `replayer.js`, `replayer.css`
- `src/replay-coordinator.js` (in background) — orchestrates step execution
- `src/replay-executor.js` (in content) — performs the actions per §9.2
- `src/selector-engine.js` (in content) — resolution algorithm per §6

**Files to modify:**
- `background.js` — wire replay coordinator
- `content.js` — wire replay executor (mode flag: capturing vs replaying — they're mutually exclusive)

**Acceptance:**
- A recording made on `simple-form.html` and immediately compiled (no edits) replays successfully
- Selector healing works: manually break the primary selector in the JSON; replay still succeeds via alternative; report shows `selectorHealed: true`
- Pause / step / skip / abort all functional in replayer UI
- Run report exported as JSON matches §9.4 schema

### Phase 5 — Parameters, loops, extractions, conditions

**Goal:** the use cases in the original brief now work end-to-end.

**Files to modify:**
- `editor.html/js` — UI for csv/json parameter sources, condition builder, extraction config
- `src/replay-coordinator.js` — loop iteration, parameter substitution, extraction collection
- `src/replay-executor.js` — handle `extract` and `assert` action types
- `replayer.html/js` — parameter input form before run; live extraction display

**Acceptance test cases (these must all pass):**
- **Test A — keyword loop:** record one search interaction → editor: parameterize the keyword, wrap as a loop with array param → run with `["AI", "ML", "robotics"]` → 3 searches happen
- **Test B — extraction:** record a click on a list item → editor: change to `extract text` → loop over a list → output JSON contains an array of texts
- **Test C — conditional skip:** record a click on a "dismiss popup" button → editor: add `selectorExists` condition → run on a page where the popup doesn't appear → step is skipped, run continues
- **Test D — login + iterate:** the original brief use case — login, navigate, then iterate downloads. End to end.

### Phase 6 — Polish & operational quality

**Goal:** make it pleasant to live with.

- Editor: drag-and-drop reorder, undo/redo, search/filter actions, side-by-side diff against previous compile
- Replayer: live screenshot strip, step timing chart, per-step retry visualization
- Storage: move screenshots out of the action JSON into separate `chrome.storage` entries referenced by ID
- Settings page: global config overrides for §12 defaults
- Recording overlay: a floating in-page widget showing "● recording — N actions captured"
- Selector healing offer: post-run prompt to update the recording with healed selectors

### Phase 7 — Codegen

- `src/codegen/playwright-python.js` — emits a `.py` file
- `src/codegen/n8n-workflow.js` — emits a `.json` workflow
- `src/codegen/standalone-extension.js` — emits a zip of a single-purpose extension
- Editor: "Export As" menu with the three targets
- Each codegen output preserves `annotations.comment` as comments

---

## 12. Configuration & defaults

Global config (in `chrome.storage.sync`, editable in settings page; defaults shipped in `src/config.js`):

```jsonc
{
  "domStableThresholdMs": 500,
  "networkIdleThresholdMs": 500,
  "longPollThresholdMs": 8000,
  "typingDebounceMs": 600,
  "defaultActionTimeoutMs": 30000,
  "defaultPostActionMinDelayMs": 100,
  "defaultRetryCount": 3,
  "defaultRetryBackoffMs": [500, 1000, 2000],
  "captureScreenshotsOnError": true,
  "captureScreenshotsEveryAction": false,
  "maskPasswordFields": true,
  "captureClipboard": false,
  "selectorIdRejectionPatterns": [
    "^mui-", "^emotion-", "^radix-", "^chakra-", "^css-",
    "^MuiBox-", "^sc-", "^:r[0-9a-z]+:$",
    "^[a-z0-9]{6,}-[a-z0-9]{6,}$"
  ]
}
```

Per-recording config in the session envelope **overrides** global config for that recording's playback.

---

## 13. Known limitations (v1 ship list)

Document these in README so users aren't surprised:

1. Closed shadow roots are not pierced
2. Native OS dialogs (file picker contents, print dialogs, browser auth dialogs) are invisible
3. Drag-and-drop is captured as a click only
4. Canvas-rendered apps (Figma, some games) have no DOM to capture
5. `chrome://`, the Web Store, and the PDF viewer cannot be recorded (browser policy)
6. No nested loops in v1
7. No parallel execution
8. Multi-tab flows are out of scope (a recording targets one tab)
9. Recording on sites that use Trusted Types in strict mode may have selector-injection issues — workaround: settings flag to disable testid synthesis
10. Anti-bot systems (Cloudflare, hCaptcha, reCAPTCHA) may detect synthetic events. No countermeasures in v1.

---

## 14. Glossary

- **Action** — a single recorded or replayable step (click, input, navigation, extract, etc.)
- **Raw recording (`.rec.json`)** — output of capture; flat list of observed actions
- **Compiled recording (`.cr.json`)** — output of the editor; raw recording plus parameters, loops, extractions, wait policies
- **Run** — one execution of a compiled recording
- **Run report** — JSON output of a run with per-step status, healing events, extractions
- **Selector bundle** — the §3.3 object with primary + alternatives + xpath + textContent
- **Selector healing** — a successful run where the primary selector failed but an alternative succeeded
- **Wait policy** — the §5.1 object describing how replay should wait around a step
- **Wait observation** — the §3.5 object captured for each action describing what was true on the page just before it
- **Frame path** — the array of selectors needed to descend from the top frame into the frame where an action occurred
- **Long-poll exclusion** — the rule (§4.9) that drops persistent connections from the network-idle calculation
