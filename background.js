// background.js — service worker
// Owns session state, network observations, downloads, and the per-session frame registry.
// Spec v1.0.0 §2 (architecture), §3.1 (envelope), §4.6/4.8/4.9 (nav/download/network), §4.10 (frame).

const SESSION_KEY = 'currentSession';
const HISTORY_KEY = 'sessions';
const SCHEMA_VERSION = '1.0.0';

// ---------- spec §12 defaults ----------
const CFG = {
  domStableThresholdMs: 500,
  networkIdleThresholdMs: 500,
  longPollThresholdMs: 8000
};

// ---------- in-memory per-tab network observation state (§4.9) ----------
// Resets when the service worker restarts; that's fine — it is only used while
// a recording is active.
const tabNet = new Map(); // tabId -> { pending: Set<requestId>, lastActivityAt: number, started: Map<requestId, number>, excluded: Set<requestId> }

function netState(tabId) {
  let s = tabNet.get(tabId);
  if (!s) {
    s = { pending: new Set(), lastActivityAt: null, started: new Map(), excluded: new Set() };
    tabNet.set(tabId, s);
  }
  return s;
}

function maybeExcludeLongPoll(tabId, requestId) {
  const s = netState(tabId);
  if (s.excluded.has(requestId)) return;
  const startedAt = s.started.get(requestId);
  if (startedAt && (Date.now() - startedAt) >= CFG.longPollThresholdMs && s.pending.has(requestId)) {
    s.pending.delete(requestId);
    s.excluded.add(requestId);
  }
}

// ---------- frame registry: frameId -> { framePath: SelectorBundle[] } (§4.10) ----------
// Built incrementally as child frames register themselves on `recorder:start`.
// frameSelectors[frameId] = SelectorBundle for the <iframe> element of that frame
// (as supplied by the *child* frame from window.frameElement).
const sessionFrameInfo = {
  tabId: null,
  // frameId -> SelectorBundle (the iframe element pointing at this frame, from parent's perspective)
  selectorsByFrameId: new Map(),
  // frameId -> parentFrameId (cached from chrome.webNavigation)
  parentByFrameId: new Map()
};

function resetFrameInfo(tabId) {
  sessionFrameInfo.tabId = tabId;
  sessionFrameInfo.selectorsByFrameId.clear();
  sessionFrameInfo.parentByFrameId.clear();
}

async function refreshFrameTree(tabId) {
  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    if (!frames) return;
    for (const f of frames) {
      sessionFrameInfo.parentByFrameId.set(f.frameId, f.parentFrameId);
    }
  } catch (_) { /* tab may be gone */ }
}

function computeFramePath(frameId) {
  // Walk from this frame up to the top, collecting selectors at each step.
  const chain = [];
  let cur = frameId;
  const guard = new Set();
  while (cur != null && cur !== 0 && !guard.has(cur)) {
    guard.add(cur);
    const sel = sessionFrameInfo.selectorsByFrameId.get(cur);
    if (sel) chain.push(sel);
    const parent = sessionFrameInfo.parentByFrameId.get(cur);
    if (parent == null || parent === cur) break;
    cur = parent;
  }
  // Collected child→top; framePath needs top→child.
  return chain.reverse();
}

// ---------- session helpers ----------
async function getCurrentSession() {
  const r = await chrome.storage.local.get(SESSION_KEY);
  return r[SESSION_KEY] || null;
}

async function setCurrentSession(s) {
  await chrome.storage.local.set({ [SESSION_KEY]: s });
}

async function getViewport(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab && tab.width && tab.height) return { width: tab.width, height: tab.height };
  } catch (_) {}
  // chrome.tabs may not include dimensions; fall back to window
  try {
    const win = await chrome.windows.getCurrent({ populate: false });
    if (win && win.width && win.height) return { width: win.width, height: win.height };
  } catch (_) {}
  return { width: 0, height: 0 };
}

async function startSession(tab) {
  const viewport = await getViewport(tab.id);
  const session = {
    schemaVersion: SCHEMA_VERSION,
    id: 'sess_' + Date.now(),
    createdAt: Date.now(),
    endedAt: null,
    startUrl: tab.url || '',
    userAgent: (typeof navigator !== 'undefined' && navigator.userAgent) ? navigator.userAgent : '',
    viewport,
    tabId: tab.id,
    actions: []
  };
  await setCurrentSession(session);
  await chrome.storage.local.set({ recordingActive: true });
  resetFrameInfo(tab.id);
  await refreshFrameTree(tab.id);
  // Reset per-tab network state for a clean baseline
  tabNet.set(tab.id, { pending: new Set(), lastActivityAt: null, started: new Map(), excluded: new Set() });
  try { await chrome.tabs.sendMessage(tab.id, { type: 'recorder:start' }); } catch (_) {}
  return session;
}

async function stopSession() {
  const sess = await getCurrentSession();
  if (!sess) return null;
  sess.endedAt = Date.now();
  // Renumber action ids sequentially within the session for readability — keeps the
  // `^act_` schema constraint and produces deterministic output across frames.
  for (let i = 0; i < sess.actions.length; i++) {
    sess.actions[i].id = `act_${(i + 1).toString().padStart(4, '0')}`;
  }
  const r = await chrome.storage.local.get(HISTORY_KEY);
  const history = r[HISTORY_KEY] || [];
  history.push(sess);
  await chrome.storage.local.set({
    [HISTORY_KEY]: history,
    recordingActive: false
  });
  await chrome.storage.local.remove(SESSION_KEY);
  if (sess.tabId) {
    try { await chrome.tabs.sendMessage(sess.tabId, { type: 'recorder:stop' }); } catch (_) {}
  }
  return sess;
}

function fillNetworkObservations(action, tabId) {
  if (!action.waitBefore) action.waitBefore = {};
  const s = netState(tabId);
  // Sweep long-poll exclusions before reporting.
  for (const reqId of s.pending) maybeExcludeLongPoll(tabId, reqId);
  const pending = s.pending.size;
  const lastActivityAt = s.lastActivityAt;
  const msSinceLastNet = lastActivityAt != null ? (Date.now() - lastActivityAt) : null;
  const wasNetworkIdle = pending === 0 &&
    (msSinceLastNet == null || msSinceLastNet >= CFG.networkIdleThresholdMs);
  action.waitBefore.pendingNetworkRequests = pending;
  action.waitBefore.msSinceLastNetworkActivity = msSinceLastNet;
  action.waitBefore.wasNetworkIdle = wasNetworkIdle;
  // Re-affirm wasDomStable using whatever the content script computed,
  // defaulting to true if absent.
  if (typeof action.waitBefore.wasDomStable !== 'boolean') {
    action.waitBefore.wasDomStable = true;
  }
}

async function appendAction(action, sender) {
  const sess = await getCurrentSession();
  if (!sess) return;
  // Only capture actions from the recorded tab (other tabs may also have content scripts)
  if (sender?.tab?.id && sess.tabId && sender.tab.id !== sess.tabId) return;

  const frameId = sender?.frameId ?? 0;
  action.frameId = frameId;
  action.framePath = computeFramePath(frameId);
  fillNetworkObservations(action, sess.tabId);

  sess.actions.push(action);
  await setCurrentSession(sess);
}

// ---------- chrome.webRequest network observation (§4.9) ----------
function isRecordedTab(tabId) {
  return tabId != null && sessionFrameInfo.tabId === tabId;
}

chrome.webRequest.onBeforeRequest.addListener((details) => {
  if (!isRecordedTab(details.tabId)) return;
  const s = netState(details.tabId);
  s.pending.add(details.requestId);
  s.started.set(details.requestId, Date.now());
  s.lastActivityAt = Date.now();
}, { urls: ['<all_urls>'] });

chrome.webRequest.onHeadersReceived.addListener((details) => {
  if (!isRecordedTab(details.tabId)) return;
  // SSE / event-stream → exclude immediately (§4.9 long-poll/SSE rule)
  const headers = details.responseHeaders || [];
  for (const h of headers) {
    if (h.name && h.name.toLowerCase() === 'content-type') {
      const v = (h.value || '').toLowerCase();
      if (v.startsWith('text/event-stream')) {
        const s = netState(details.tabId);
        if (s.pending.has(details.requestId)) {
          s.pending.delete(details.requestId);
          s.excluded.add(details.requestId);
        }
        break;
      }
    }
  }
}, { urls: ['<all_urls>'] }, ['responseHeaders']);

function clearRequest(details) {
  if (!isRecordedTab(details.tabId)) return;
  const s = netState(details.tabId);
  s.pending.delete(details.requestId);
  s.excluded.delete(details.requestId);
  s.started.delete(details.requestId);
  s.lastActivityAt = Date.now();
}
chrome.webRequest.onCompleted.addListener(clearRequest, { urls: ['<all_urls>'] });
chrome.webRequest.onErrorOccurred.addListener(clearRequest, { urls: ['<all_urls>'] });

// ---------- chrome.webNavigation (§4.6 + frame tracking) ----------
chrome.webNavigation.onCommitted.addListener(async (details) => {
  // Maintain frame tree for any frame in the recorded tab
  const sess = await getCurrentSession();
  if (!sess || sess.tabId !== details.tabId) return;
  sessionFrameInfo.parentByFrameId.set(details.frameId, details.parentFrameId);

  if (details.frameId !== 0) return;
  // Top-frame full page nav → emit navigation:committed
  const action = {
    id: `act_nav_${Date.now()}`,
    type: 'navigation:committed',
    timestamp: Date.now(),
    url: details.url,
    title: '',
    frameId: 0,
    framePath: [],
    selectors: null,
    element: null,
    waitBefore: {
      msSinceLastAction: null,
      msSinceLastMutation: null,
      domMutationsObservedSinceLastAction: 0,
      pendingNetworkRequests: 0,
      msSinceLastNetworkActivity: null,
      wasNetworkIdle: false,
      wasDomStable: true
    },
    annotations: { label: '', comment: '' },
    transitionType: details.transitionType || 'link'
  };
  fillNetworkObservations(action, details.tabId);
  sess.actions.push(action);
  await setCurrentSession(sess);
});

chrome.webNavigation.onDOMContentLoaded.addListener(async (details) => {
  const sess = await getCurrentSession();
  if (!sess || sess.tabId !== details.tabId) return;
  // Re-inject listener after navigation
  try { await chrome.tabs.sendMessage(details.tabId, { type: 'recorder:start' }, { frameId: details.frameId }); } catch (_) {}
});

// ---------- chrome.downloads (§4.8) ----------
chrome.downloads.onCreated.addListener(async (item) => {
  const sess = await getCurrentSession();
  if (!sess) return;
  // chrome.downloads doesn't always tell us which tab initiated; best-effort match.
  // If we have a recorded tab, we attribute the download to it.
  const action = {
    id: `act_dl_${Date.now()}`,
    type: 'download:started',
    timestamp: Date.now(),
    url: item.url || '',
    title: '',
    frameId: 0,
    framePath: [],
    selectors: null,
    element: null,
    waitBefore: {
      msSinceLastAction: null,
      msSinceLastMutation: null,
      domMutationsObservedSinceLastAction: 0,
      pendingNetworkRequests: 0,
      msSinceLastNetworkActivity: null,
      wasNetworkIdle: false,
      wasDomStable: true
    },
    annotations: { label: '', comment: '' },
    downloadInfo: {
      filename: item.filename || '',
      url: item.url || '',
      mimeType: item.mime || '',
      bytesTotal: item.totalBytes >= 0 ? item.totalBytes : 0
    }
  };
  if (sess.tabId) fillNetworkObservations(action, sess.tabId);
  sess.actions.push(action);
  await setCurrentSession(sess);
});

// ---------- popup / content script messaging ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === 'recorder:action') {
        await appendAction(msg.action, sender);
        return sendResponse({ ok: true });
      }
      if (msg?.type === 'recorder:registerFrame') {
        const frameId = sender?.frameId;
        if (frameId != null && msg.frameElementSelectors) {
          sessionFrameInfo.selectorsByFrameId.set(frameId, msg.frameElementSelectors);
        }
        // Also refresh the parent map opportunistically
        if (sender?.tab?.id) await refreshFrameTree(sender.tab.id);
        return sendResponse({ ok: true });
      }
      if (msg?.type === 'popup:start') {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab) return sendResponse({ ok: false, error: 'No active tab' });
        const session = await startSession(tab);
        return sendResponse({ ok: true, session });
      }
      if (msg?.type === 'popup:stop') {
        const session = await stopSession();
        return sendResponse({ ok: true, session });
      }
      if (msg?.type === 'popup:status') {
        const session = await getCurrentSession();
        return sendResponse({ recording: !!session, session });
      }
      if (msg?.type === 'popup:export') {
        const r = await chrome.storage.local.get(HISTORY_KEY);
        return sendResponse({ sessions: r[HISTORY_KEY] || [] });
      }
      if (msg?.type === 'popup:clear') {
        await chrome.storage.local.set({ [HISTORY_KEY]: [] });
        return sendResponse({ ok: true });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
  })();
  return true;
});
