// types.v1.ts — Interaction Recorder schema v1.0.0 type definitions

export const SCHEMA_VERSION = "1.0.0" as const;

// ─── Selectors ───────────────────────────────────────────────────────────────

export type SelectorKind =
  | "testid"
  | "id"
  | "name"
  | "aria"
  | "roleText"
  | "css"
  | "xpath";

export interface SelectorAlternative {
  kind: SelectorKind;
  value: string;
}

export interface SelectorBundle {
  primary: string | null;
  alternatives: SelectorAlternative[];
  xpath: string | null;
  textContent: string;
  accessibleName: string;
  tagName: string | null;
  attributes: Record<string, string>;
}

// ─── Element snapshot ────────────────────────────────────────────────────────

export interface ElementSnapshot {
  tagName: string | null;
  type: string | null;
  innerText: string;
  boundingRect: { x: number; y: number; width: number; height: number };
  isVisible: boolean;
  computedRole: string | null;
  isContentEditable: boolean;
  valueSnapshot: string | null;
}

// ─── Wait observations / policy ──────────────────────────────────────────────

export interface WaitObservations {
  msSinceLastAction: number | null;
  msSinceLastMutation: number | null;
  domMutationsObservedSinceLastAction: number;
  pendingNetworkRequests: number;
  msSinceLastNetworkActivity: number | null;
  wasNetworkIdle: boolean;
  wasDomStable: boolean;
}

export interface WaitPolicy {
  preNavigation: {
    waitForUrlPattern: string | null;
    timeoutMs: number;
  };
  preTarget: {
    waitForSelector: boolean;
    requireUnique: boolean;
    timeoutMs: number;
  };
  preStability: {
    domStable: boolean;
    domStableMs: number;
    networkIdle: boolean;
    networkIdleMs: number;
  };
  postAction: {
    waitForSelector: SelectorBundle | null;
    waitForUrlChange: boolean;
    waitForDownload: boolean;
    minDelayMs: number;
    timeoutMs: number;
  };
  retries: {
    max: number;
    backoffMs: number[];
    onTotalFailure: "fail" | "skip" | "prompt";
  };
}

// ─── Conditions ──────────────────────────────────────────────────────────────

export type ConditionType =
  | "selectorExists"
  | "selectorMissing"
  | "urlMatches"
  | "textPresent"
  | "previousActionStatus";

export interface Condition {
  type: ConditionType;
  selector?: SelectorBundle;
  urlPattern?: string;
  text?: string;
  previousActionId?: string;
  expectedStatus?: "success" | "failed" | "skipped";
  ifFalse: "skip" | "abort";
}

// ─── Actions ─────────────────────────────────────────────────────────────────

export type ActionType =
  | "click"
  | "dblclick"
  | "input"
  | "change"
  | "submit"
  | "keydown"
  | "navigation:committed"
  | "navigation:spa"
  | "frame:ready"
  | "download:started"
  | "extract"
  | "wait"
  | "assert";

export interface ActionBase {
  id: string;
  type: ActionType;
  timestamp: number;
  url: string;
  title?: string;
  frameId: number;
  framePath: SelectorBundle[];
  selectors: SelectorBundle | null;
  element: ElementSnapshot | null;
  waitBefore?: WaitObservations;
  waitPolicy?: WaitPolicy;          // compiled only
  condition?: Condition;            // compiled only
  loopRef?: string | null;          // compiled only
  parameterRefs?: string[];         // compiled only
  annotations?: { label: string; comment: string };
}

export interface ClickAction extends ActionBase {
  type: "click" | "dblclick";
  button?: number;
  modifiers?: { ctrl: boolean; shift: boolean; alt: boolean; meta: boolean };
}

export interface InputAction extends ActionBase {
  type: "input";
  value: string;                    // may contain {{paramName}} after compile
  inputType: string | null;
}

export interface ChangeAction extends ActionBase {
  type: "change";
  value: string | boolean;
  inputType: string | null;
}

export interface SubmitAction extends ActionBase {
  type: "submit";
}

export interface KeydownAction extends ActionBase {
  type: "keydown";
  key: string;
  modifiers?: { ctrl: boolean; shift: boolean; alt: boolean; meta: boolean };
}

export interface NavigationCommittedAction extends ActionBase {
  type: "navigation:committed";
  transitionType?: string;
}

export interface NavigationSpaAction extends ActionBase {
  type: "navigation:spa";
  newUrl: string;
}

export interface FrameReadyAction extends ActionBase {
  type: "frame:ready";
}

export interface DownloadStartedAction extends ActionBase {
  type: "download:started";
  downloadInfo: {
    filename: string;
    url: string;
    mimeType: string;
    bytesTotal: number;
  };
}

export interface ExtractAction extends ActionBase {
  type: "extract";
  extractConfig: {
    extract: string;                // "text" | "innerHTML" | "value" | "boundingRect" | `attribute:${string}`
    storeAs: string;
    missingPolicy: "null" | "skip-iteration" | "fail";
  };
}

export interface WaitAction extends ActionBase {
  type: "wait";
  waitConfig: {
    durationMs?: number;
    untilSelector?: SelectorBundle;
    untilUrlPattern?: string;
    timeoutMs: number;
  };
}

export interface AssertAction extends ActionBase {
  type: "assert";
  assertConfig: {
    type: "selectorExists" | "selectorMissing" | "textPresent" | "urlMatches" | "valueEquals";
    selector?: SelectorBundle;
    expected?: string | number | boolean | null;
    onFail: "fail" | "warn";
  };
}

export type Action =
  | ClickAction
  | InputAction
  | ChangeAction
  | SubmitAction
  | KeydownAction
  | NavigationCommittedAction
  | NavigationSpaAction
  | FrameReadyAction
  | DownloadStartedAction
  | ExtractAction
  | WaitAction
  | AssertAction;

// ─── Compile-time artifacts: parameters, loops, extractions ─────────────────

export type ParameterType =
  | "string"
  | "number"
  | "boolean"
  | "array<string>"
  | "array<number>";

export type ParameterSource = "input" | "csv" | "json" | "env" | "extraction";

export interface Parameter {
  name: string;
  type: ParameterType;
  source: ParameterSource;
  sourceConfig?: {
    promptLabel?: string;
    default?: unknown;
    secret?: boolean;
    extractionRef?: string;
  };
  description?: string;
}

export interface Loop {
  id: string;
  name?: string;
  iterates: string;                 // parameter name, must be array<*>
  itemAlias: string;
  indexAlias?: string;
  startActionId: string;
  endActionId: string;
  onError: "continue" | "abort" | "retry-once";
}

export interface ExtractionRegistration {
  id: string;
  actionId: string;
  name: string;
  selectors?: SelectorBundle;
  extract: string;                  // mirror of extractConfig.extract
  storeAs: string;
  missingPolicy: "null" | "skip-iteration" | "fail";
}

// ─── Session envelope ────────────────────────────────────────────────────────

export interface Session {
  schemaVersion: typeof SCHEMA_VERSION;
  id: string;
  name?: string;                    // compiled only
  description?: string;             // compiled only
  createdAt: number;
  endedAt: number | null;
  startUrl: string;
  userAgent: string;
  viewport: { width: number; height: number };
  tabId?: number;                   // raw only
  parameters?: Parameter[];         // compiled only
  loops?: Loop[];                   // compiled only
  extractions?: ExtractionRegistration[]; // compiled only
  actions: Action[];
  config?: Partial<RecorderConfig>;
}

// ─── Run report (output of a replay) ─────────────────────────────────────────

export type RunStatus = "success" | "failed" | "aborted" | "partial";
export type StepStatus = "success" | "failed" | "skipped";

export interface RunStepReport {
  actionId: string;
  status: StepStatus;
  durationMs: number;
  selectorUsed: string | null;
  selectorHealed: boolean;
  originalPrimary?: string;
  retries: number;
  logs: string[];
  errorMessage?: string;
  screenshotId?: string;
}

export interface RunLoopIterationReport {
  loopId: string;
  index: number;
  item: unknown;
  status: StepStatus;
  failedActionId?: string;
}

export interface RunReport {
  runId: string;
  recordingId: string;
  startedAt: number;
  endedAt: number;
  status: RunStatus;
  parameters: Record<string, unknown>;
  steps: RunStepReport[];
  loopIterations: RunLoopIterationReport[];
  extractions: Record<string, unknown>;
  screenshots: { id: string; actionId: string; dataUrl: string }[];
}

// ─── Global config ───────────────────────────────────────────────────────────

export interface RecorderConfig {
  domStableThresholdMs: number;
  networkIdleThresholdMs: number;
  longPollThresholdMs: number;
  typingDebounceMs: number;
  defaultActionTimeoutMs: number;
  defaultPostActionMinDelayMs: number;
  defaultRetryCount: number;
  defaultRetryBackoffMs: number[];
  captureScreenshotsOnError: boolean;
  captureScreenshotsEveryAction: boolean;
  maskPasswordFields: boolean;
  captureClipboard: boolean;
  selectorIdRejectionPatterns: string[];
}

export const DEFAULT_CONFIG: RecorderConfig = {
  domStableThresholdMs: 500,
  networkIdleThresholdMs: 500,
  longPollThresholdMs: 8000,
  typingDebounceMs: 600,
  defaultActionTimeoutMs: 30000,
  defaultPostActionMinDelayMs: 100,
  defaultRetryCount: 3,
  defaultRetryBackoffMs: [500, 1000, 2000],
  captureScreenshotsOnError: true,
  captureScreenshotsEveryAction: false,
  maskPasswordFields: true,
  captureClipboard: false,
  selectorIdRejectionPatterns: [
    "^mui-",
    "^emotion-",
    "^radix-",
    "^chakra-",
    "^css-",
    "^MuiBox-",
    "^sc-",
    "^:r[0-9a-z]+:$",
    "^[a-z0-9]{6,}-[a-z0-9]{6,}$"
  ]
};
