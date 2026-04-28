# Interaction Recorder

A Chrome extension that records browser interactions and replays them as parameterized, looping automations. Records once, runs many times.

**Status:** Phase 1 — schema-conformant capture. Full v1 spec at [`spec/SPEC.md`](spec/SPEC.md).

---

## What's in this folder

| Path | What it is |
|---|---|
| `manifest.json`, `background.js`, `content.js`, `popup.html`, `popup.js` | **Phase 1 capture extension.** Load it as unpacked, hit Start, do the thing, hit Stop, Export. Output is full v1.0.0 schema. |
| `src/schema-validator.js` | Runtime validator for the v1 schema. Used by tests and (later) by the editor / replayer. |
| `src/types.ts` | TypeScript types — vendored copy of `spec/types.v1.ts`. |
| `spec/SPEC.md` | **The contract.** Schema, wait/retry policy, loop/parameter model, build phases. Source of truth for everything below. |
| `spec/schema.v1.json` | JSON Schema (draft-07) for runtime validation of recordings. |
| `test/fixtures/*.html` | Pages exercising click/input/submit, iframes, and SPA pushState navigation. |
| `test/*.js` | Node smoke tests — run `node test/validate-fixture.js`, `node test/validator-rejects-invalid.js`, `node test/auto-id-rejection.js`. |
| `spec/types.v1.ts` | TypeScript type definitions matching the schema. |

---

## Install (unpacked, dev mode)

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**, pick this folder
4. Pin the extension to the toolbar

## Use the v0.1 capture

1. Navigate to a page
2. Click the extension icon → **Start Recording**
3. Interact with the page
4. Click **Stop Recording** → **Export Sessions (JSON)**

The exported JSON is the input for the editor and playback engine in later phases.

---

## How to read the spec

The spec is structured for three different uses:

- **Building the next phase?** Jump to `SPEC.md` §11. Each phase is a self-contained ticket with files to create, files to modify, and acceptance criteria. Sections 3–10 are the contract those phases reference.
- **Wondering what gets captured?** §3 Schema and §4 Capture rules.
- **Wondering how replay handles slow pages?** §5 Wait & retry policy.
- **Wondering how looping over a list of inputs works?** §3.6, §3.7, §3.8.
- **Wondering what won't work?** §13 Known limitations.

---

## Phase summary (full detail in spec)

| Phase | Goal | Outcome |
|---|---|---|
| 1 | Schema lock | v0.1 capture emits valid v1.0.0 JSON |
| 2 | Capture enhancements | Network idle, downloads, shadow DOM, screenshots |
| 3 | Editor v1 | Raw recording → compiled recording with params/loops/extractions |
| 4 | Playback v1 | Execute simple compiled recordings (no params/loops yet) |
| 5 | Params, loops, extractions, conditions | Full automation feature set — original brief use cases work |
| 6 | Polish | Drag/drop reorder, run timing charts, settings page, recording overlay |
| 7 | Codegen | Emit Playwright Python and n8n workflows |

End of Phase 5 = the "iterate ChatGPT history / search keywords / login → export → next" use cases are working end to end.

---

## Handoff to Claude Code

The spec is written to be a self-contained brief. To start Phase 1:

> *Read `spec/SPEC.md`. Implement Phase 1 (§11). The acceptance tests at the bottom of that section are the contract. Don't change schema decisions in §3 — those are locked.*

Subsequent phases work the same way — each phase points at the spec sections it depends on.
