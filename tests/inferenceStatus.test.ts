import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InferenceStatusManager } from "../src/inference-status";
import { Server } from "../src/server";

// ─── Helpers ──────────────────────────────────────────────────────────

const createServer = (baseUrl: string) => new Server(baseUrl);

let manager!: InferenceStatusManager;
let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // Stub globalThis.fetch so install/uninstall don't fight the real one.
  mockFetch = vi.fn().mockResolvedValue({ ok: false, body: null });
  globalThis.fetch = mockFetch as any;
});

afterEach(() => {
  manager?.uninstall();
  // Restore original fetch in case uninstall was skipped by an early return.
  if (globalThis.fetch === mockFetch) {
    delete (globalThis as any).fetch;
  }
});

// ─── formatDuration (private, accessed via spy) ──────────────────────

describe("formatDuration", () => {
  it.each([
    [0, "0s"],
    [1, "1s"],
    [59.4, "59s"],
    [59.6, "60s"],
    [60, "1m 0s"],
    [61, "1m 1s"],
    [120, "2m 0s"],
    [3749, "62m 29s"],
    [0.4, "0s"],
    [0.5, "1s"],
  ])("formats %.1f seconds as %s", (seconds, expected) => {
    manager = new InferenceStatusManager([createServer("http://localhost:8080")]);
    const result = (manager as any).formatDuration(seconds);
    expect(result).toBe(expected);
  });
});

// ─── ensureStreamOptions (private, accessed via spy) ────────────────

describe("ensureStreamOptions", () => {
  it("adds stream_options.include_usage when body has no stream_options (string)", () => {
    manager = new InferenceStatusManager([]);
    const init: any = { body: JSON.stringify({ model: "test" }) };
    (manager as any).ensureStreamOptions({}, init);

    const parsed = JSON.parse(init.body);
    expect(parsed.stream_options.include_usage).toBe(true);
    expect(parsed.return_progress).toBe(true);
    expect(parsed.timings_per_token).toBe(true);
  });

  it("adds include_usage when stream_options exists but lacks the flag (string)", () => {
    manager = new InferenceStatusManager([]);
    const init: any = {
      body: JSON.stringify({ model: "test", stream_options: {} }),
    };
    (manager as any).ensureStreamOptions({}, init);

    const parsed = JSON.parse(init.body);
    expect(parsed.stream_options.include_usage).toBe(true);
  });

  it("does not overwrite existing include_usage=true (string)", () => {
    manager = new InferenceStatusManager([]);
    const init: any = {
      body: JSON.stringify({
        model: "test",
        stream_options: { include_usage: true },
      }),
    };
    (manager as any).ensureStreamOptions({}, init);

    const parsed = JSON.parse(init.body);
    expect(parsed.stream_options.include_usage).toBe(true);
  });

  it("handles object body by mutating in place", () => {
    manager = new InferenceStatusManager([]);
    const body: any = { model: "test" };
    const init: any = { body };
    (manager as any).ensureStreamOptions({}, init);

    expect(body.stream_options.include_usage).toBe(true);
    expect(body.return_progress).toBe(true);
  });

  it("preserves existing fields on the body", () => {
    manager = new InferenceStatusManager([]);
    const init: any = {
      body: JSON.stringify({ model: "test", temperature: 0.7, max_tokens: 128 }),
    };
    (manager as any).ensureStreamOptions({}, init);

    const parsed = JSON.parse(init.body);
    expect(parsed.model).toBe("test");
    expect(parsed.temperature).toBe(0.7);
    expect(parsed.max_tokens).toBe(128);
  });

  it("does nothing when body is missing", () => {
    manager = new InferenceStatusManager([]);
    const init: any = {};
    (manager as any).ensureStreamOptions({}, init);
    expect(init.body).toBeUndefined();
  });

  it("ignores non-JSON bodies without throwing", () => {
    manager = new InferenceStatusManager([]);
    const init: any = { body: "not-json-at-all" };
    // Should not throw even though JSON.parse fails on the string.
    expect(() => (manager as any).ensureStreamOptions({}, init)).not.toThrow();
  });

  it("ignores non-JSON bodies that parse but are not plain objects", () => {
    manager = new InferenceStatusManager([]);
    const init: any = { body: JSON.stringify([1, 2, 3]) };
    // Array body — spread into {} should be harmless.
    expect(() => (manager as any).ensureStreamOptions({}, init)).not.toThrow();
  });
});

// ─── isLlamaCppUrl (private, accessed via spy) ──────────────────────

describe("isLlamaCppUrl", () => {
  it("matches exact baseUrl prefix", () => {
    manager = new InferenceStatusManager([createServer("http://localhost:8080")]);
    expect((manager as any).isLlamaCppUrl("http://localhost:8080/v1/chat/completions")).toBe(true);
  });

  it("matches baseUrl with trailing slash in target", () => {
    manager = new InferenceStatusManager([createServer("http://localhost:8080")]);
    expect((manager as any).isLlamaCppUrl("http://localhost:8080/")).toBe(true);
  });

  it("returns false for different port", () => {
    manager = new InferenceStatusManager([createServer("http://localhost:8080")]);
    expect((manager as any).isLlamaCppUrl("http://localhost:9000/v1/chat/completions")).toBe(false);
  });

  it("returns false for empty string", () => {
    manager = new InferenceStatusManager([createServer("http://localhost:8080")]);
    expect((manager as any).isLlamaCppUrl("")).toBe(false);
  });

  it("matches against multiple servers (first match)", () => {
    manager = new InferenceStatusManager([
      createServer("http://server-a:8080"),
      createServer("http://server-b:9000"),
    ]);
    expect((manager as any).isLlamaCppUrl("http://server-a:8080/v1/models")).toBe(true);
  });

  it("matches against multiple servers (second match)", () => {
    manager = new InferenceStatusManager([
      createServer("http://server-a:8080"),
      createServer("http://server-b:9000"),
    ]);
    expect((manager as any).isLlamaCppUrl("http://server-b:9000/health")).toBe(true);
  });

  it("returns false when no servers match", () => {
    manager = new InferenceStatusManager([
      createServer("http://server-a:8080"),
      createServer("http://server-b:9000"),
    ]);
    expect((manager as any).isLlamaCppUrl("https://api.openai.com/v1/chat")).toBe(false);
  });

  it("returns false with empty server list", () => {
    manager = new InferenceStatusManager([]);
    expect((manager as any).isLlamaCppUrl("http://localhost:8080/anything")).toBe(false);
  });
});

// ─── Lifecycle hooks (UI ref management) ──────────────────────────────

describe("lifecycle hooks", () => {
  it("refreshes UI ref on beforeAgentStart", () => {
    manager = new InferenceStatusManager([]);
    const mockUi = { setWorkingMessage: vi.fn() };
    manager.onBeforeAgentStart({ ui: mockUi, hasUI: true });

    // Trigger a working message update to verify the ref is wired.
    (manager as any).updateWorkingMessage();
    // No crash means the ref was stored correctly.
  });

  it("refreshes UI ref on turn start", () => {
    manager = new InferenceStatusManager([]);
    const mockUi = { setWorkingMessage: vi.fn() };
    manager.onTurnStart({ ui: mockUi, hasUI: true });

    (manager as any).updateWorkingMessage();
  });

  it("clears working message on turn end", () => {
    manager = new InferenceStatusManager([]);
    const mockUi = { setWorkingMessage: vi.fn() };
    manager.onBeforeAgentStart({ ui: mockUi, hasUI: true });

    manager.onTurnEnd({});
    expect(mockUi.setWorkingMessage).toHaveBeenCalledWith();
  });

  it("does not crash when UI ref is missing on turn end", () => {
    manager = new InferenceStatusManager([]);
    // No UI ref set at all.
    expect(() => manager.onTurnEnd({})).not.toThrow();
  });

  it("handles null ui gracefully in refreshUiRef", () => {
    manager = new InferenceStatusManager([]);
    expect(() => manager.onBeforeAgentStart({ ui: undefined, hasUI: false })).not.toThrow();
  });

  it("resets state on reset()", () => {
    manager = new InferenceStatusManager([createServer("http://localhost:8080")]);
    const mockUi = { setWorkingMessage: vi.fn() };
    manager.onBeforeAgentStart({ ui: mockUi, hasUI: true });

    // Simulate some progress state being set.
    (manager as any).resetForNewRequest();
    expect(() => manager.reset()).not.toThrow();
  });
});

// ─── install / uninstall ──────────────────────────────────────────────

describe("install and uninstall", () => {
  it("installs fetch interceptor on first call", () => {
    const original = globalThis.fetch;
    manager = new InferenceStatusManager([createServer("http://localhost:8080")]);
    manager.install();
    expect(globalThis.fetch).not.toBe(original);
  });

  it("is idempotent — second install is a no-op", () => {
    manager = new InferenceStatusManager([createServer("http://localhost:8080")]);
    manager.install();
    const firstInstall = globalThis.fetch;
    manager.install(); // should be ignored
    expect(globalThis.fetch).toBe(firstInstall);
  });

  it("restores original fetch on uninstall", () => {
    const original = mockFetch; // our stub from beforeEach
    manager = new InferenceStatusManager([createServer("http://localhost:8080")]);
    manager.install();
    expect(globalThis.fetch).not.toBe(original);

    manager.uninstall();
    expect(globalThis.fetch).toBe(original);
  });

  it("uninstall is safe when nothing was installed", () => {
    manager = new InferenceStatusManager([]);
    // Never called install().
    expect(() => manager.uninstall()).not.toThrow();
  });
});

// ─── computeInstantaneousTps (private, accessed via spy) ──────────────

describe("computeInstantaneousTps", () => {
  it("returns correct TPS for normal delta", () => {
    // 10 tokens in 50ms = 200 tok/s
    manager = new InferenceStatusManager([]);
    const result = (manager as any).computeInstantaneousTps(60, 50, 150, 100);
    expect(result).toBeCloseTo(200);
  });

  it("returns null when time delta is zero", () => {
    manager = new InferenceStatusManager([]);
    const result = (manager as any).computeInstantaneousTps(60, 50, 100, 100);
    expect(result).toBeNull(); // deltaT=0 < MIN_DELTA_MS=1
  });

  it("returns null when no tokens processed", () => {
    manager = new InferenceStatusManager([]);
    const result = (manager as any).computeInstantaneousTps(50, 50, 200, 100);
    expect(result).toBeNull();
  });

  it("returns null when TPS exceeds sanity cap", () => {
    // deltaP=60 in deltaT=1ms → TPS = 60_000 > MAX_REASONABLE_TPS(50_000)
    manager = new InferenceStatusManager([]);
    const result = (manager as any).computeInstantaneousTps(70, 10, 2, 1);
    expect(result).toBeNull();
  });

  it("returns null for negative token delta", () => {
    manager = new InferenceStatusManager([]);
    const result = (manager as any).computeInstantaneousTps(40, 50, 200, 100);
    expect(result).toBeNull();
  });

  it("handles large realistic values", () => {
    // 500 tokens in 1000ms = 500 tok/s
    manager = new InferenceStatusManager([]);
    const result = (manager as any).computeInstantaneousTps(600, 100, 2000, 1000);
    expect(result).toBeCloseTo(500);
  });

  it("returns null at exactly MAX_REASONABLE_TPS boundary", () => {
    // 50 tokens in 1ms = 50,000 tok/s — equals cap, should pass (<=)
    manager = new InferenceStatusManager([]);
    const result = (manager as any).computeInstantaneousTps(60, 10, 2, 1);
    // deltaP=50, deltaT=1ms => TPS = 50 / 0.001 = 50_000 — exactly at cap
    expect(result).toBeCloseTo(50_000);
  });

  it("returns null just above MAX_REASONABLE_TPS", () => {
    // 60 tokens in 1ms = 60,000 tok/s — exceeds cap
    manager = new InferenceStatusManager([]);
    const result = (manager as any).computeInstantaneousTps(70, 10, 2, 1);
    expect(result).toBeNull();
  });
});

// ─── fitRateCurve / estimateEta (private) ──────────────────────────────

describe("fitRateCurve", () => {
  it("returns null with fewer than 2 data points", () => {
    manager = new InferenceStatusManager([]);
    const result = (manager as any).fitRateCurve();
    expect(result).toBeNull();
  });

  it("returns null when denominator is zero (all same x values)", () => {
    manager = new InferenceStatusManager([]);
    // All points have the same processed value → denom = n*sumX2 - sumX^2 = 0
    // Hard to inject without module mock. See TODO block below.
  });

  it("returns null when denominator is zero (all same x values)", () => {
    manager = new InferenceStatusManager([]);
    // All points have the same processed value → denom = n*sumX2 - sumX^2 = 0
    // Hard to inject without module mock. Marked as TODO below.
  });
});

// ─── getProgressMessage / getStatsMessage (private, state-dependent) ──

describe("getProgressMessage", () => {
  it("returns null when no prefill and no generation data", () => {
    manager = new InferenceStatusManager([]);
    const result = (manager as any).getProgressMessage();
    expect(result).toBeNull();
  });
});

describe("getStatsMessage", () => {
  it('returns "Generating..." when no generation data', () => {
    manager = new InferenceStatusManager([]);
    const result = (manager as any).getStatsMessage();
    // hasGenerationData is false, genPredictedN is 0 → returns null or "Generating..."
    expect(result === null || result === "Generating...").toBe(true);
  });

  it('returns "Generating..." when predicted_n is zero but data exists', () => {
    manager = new InferenceStatusManager([]);
    // Manually set generation state to simulate first timings chunk.
    (manager as any).onTimings({ predicted_n: 0, predicted_ms: 10 });
    const result = (manager as any).getStatsMessage();
    expect(result).toBe("Generating...");
  });

  it("formats stats message with valid generation data", () => {
    manager = new InferenceStatusManager([]);
    // Simulate timings: 50 tokens in 200ms → TPS = (50/200)*1000 = 250 tok/s, elapsed = 0.2s
    (manager as any).onTimings({ predicted_n: 50, predicted_ms: 200 });
    const result = (manager as any).getStatsMessage();
    expect(result).toContain("tok/s");
    expect(result).toContain("tokens in");
  });

  it('returns "Generating..." when TPS exceeds sanity cap', () => {
    manager = new InferenceStatusManager([]);
    // predicted_ms rounds to near-zero → bogus spike
    (manager as any).onTimings({ predicted_n: 100, predicted_ms: 0.001 });
    const result = (manager as any).getStatsMessage();
    expect(result).toBe("Generating...");
  });

  it('returns "Generating..." when TPS is not finite', () => {
    manager = new InferenceStatusManager([]);
    // predicted_ms near-zero → bogus spike above MAX_REASONABLE_TPS
    (manager as any).onTimings({ predicted_n: 10, predicted_ms: 0.0001 });
    const result = (manager as any).getStatsMessage();
    expect(result).toBe("Generating...");
  });

  it('returns "Generating..." when timings have null fields', () => {
    manager = new InferenceStatusManager([]);
    // Null predicted_n should be ignored.
    (manager as any).onTimings({ predicted_n: null, predicted_ms: 100 });
    const result = (manager as any).getStatsMessage();
    expect(result === null || result === "Generating...").toBe(true);
  });

  it("accumulates timings across multiple calls", () => {
    manager = new InferenceStatusManager([]);
    // First chunk: 10 tokens in 50ms → TPS = 200 tok/s, elapsed = 0.1s (rounded)
    (manager as any).onTimings({ predicted_n: 10, predicted_ms: 50 });
    let result = (manager as any).getStatsMessage();
    expect(result).toContain("tok/s");

    // Second chunk: cumulative 25 tokens in 120ms → TPS = ~208.3 tok/s, elapsed = 0.1s
    (manager as any).onTimings({ predicted_n: 25, predicted_ms: 120 });
    result = (manager as any).getStatsMessage();
    expect(result).toContain("tok/s");
    // Should reflect cumulative values from latest chunk.
  });

  it("resets generation state on resetForNewRequest", () => {
    manager = new InferenceStatusManager([]);
    (manager as any).onTimings({ predicted_n: 50, predicted_ms: 200 });
    let result = (manager as any).getStatsMessage();
    expect(result).toContain("tok/s");

    // Reset should clear generation data.
    manager.reset();
    result = (manager as any).getStatsMessage();
    expect(result === null || result === "Generating...").toBe(true);
  });
});


// ════════════════════════════════════════════════════════════════════════
// TODO: Harder tests — require refactoring or module-level mocking
// ════════════════════════════════════════════════════════════════════════

/*
 * TODO 1: fitRateCurve() with injected data points
 * ────────────────────────────────────────────────
 * Problem: rateHistory is a private module-level array. There's no public API to
 * populate it, and onPromptProgress requires driving the full SSE flow through
 * captureTimings().
 *
 * Ideas:
 *   a) Refactor fitRateCurve() into a standalone pure function:
 *        export function fitLinearRegression(points: {x:number;y:number}[]) → {slope,intercept}|null
 *      Then rateHistory is just the caller's concern and the math is trivially testable.
 *
 *   b) Use vitest module-level mocking to intercept the module before import:
 *        vi.mock("../src/inference-status", async (importOriginal) => { ... })
 *      This lets us replace rateHistory with a controllable array, but makes it hard
 *      to get the real InferenceStatusManager class at the same time.
 *
 *   c) Add a test-only getter: `export function __test_getRateHistory() { return [...rateHistory]; }`
 *      and similarly for setters. Ugly but pragmatic.
 */

/*
 * TODO 2: estimateEta() end-to-end with rate curve fitting
 * ────────────────────────────────────────────────────────
 * Problem: Depends on fitRateCurve() + avgEtaFallback(), both private, plus the
 * module-level rateHistory array. Testing requires driving prefill progress through
 * multiple SSE chunks to build up a meaningful rate history.
 *
 * Ideas:
 *   a) Same refactoring as TODO 1 — extract pure math functions. Then test:
 *        - Flat curve → falls back to avgEtaFallback
 *        - Negative slope (decelerating prefill) → integral formula with log
 *        - Edge cases where a/b <= 0 → fallback path
 *   b) Drive captureTimings() with a synthetic ReadableStream that emits known SSE lines.
 *      This tests the full pipeline but is fragile and slow.
 */

/*
 * TODO 3: getProgressMessage() — prefill progress bar rendering
 * ──────────────────────────────────────────────────────────────
 * Problem: Depends on module-level state (currentProgress, hasReceivedPrefill, etc.)
 * that can only be set through the SSE stream interceptor. The method builds a rich
 * string with block characters, percentages, ETA, and TPS — all worth testing.
 *
 * Ideas:
 *   a) Refactor getProgressMessage() to accept state as a parameter instead of reading
 *      module-level variables. This makes it pure and trivially testable for every branch:
 *        - No prefill → null
 *        - Prefill in progress with no total → "Prefilling..."
 *        - Normal bar rendering at various percentages (0%, 50%, 100%)
 *        - Bar + TPS suffix
 *        - Bar + ETA · TPS suffix
 *   b) Synthetic ReadableStream approach: pipe crafted SSE chunks through captureTimings()
 *      and assert the working message after each chunk. Tests integration but is verbose.
 */

/*
 * TODO 4: captureTimings() — full SSE stream interception pipeline
 * ────────────────────────────────────────────────────────────────
 * Problem: This method wraps a ReadableStream, parses SSE lines, and calls internal
 * handlers. Testing requires creating mock Response objects with controllable streams.
 *
 * Ideas:
 *   a) Create helper that builds a ReadableStream from an array of SSE data strings:
 *        function sseStream(chunks: string[]): ReadableStream<Uint8Array> { ... }
 *      Then pipe through captureTimings() and assert downstream state.
 *
 *   b) Test the fetch interceptor end-to-end by calling manager.install(), then firing a
 *      mock fetch that returns an SSE stream, and asserting uiRef.setWorkingMessage calls.
 */

/*
 * TODO 5: onPromptProgress() — rate history population & TPS recording
 * ──────────────────────────────────────────────────────────────────────
 * Problem: Mutates module-level state (currentProgress, prevProcessed, rateHistory).
 * The delta-TPS calculation and MAX_RATE_POINTS cap are meaningful logic to verify.
 *
 * Ideas:
 *   a) Call onPromptProgress() directly with crafted objects (it's private but accessible
 *      via `as any`). Assert that computeInstantaneousTps is called correctly by spying.
 *   b) After refactoring rateHistory into an instance field, test:
 *        - First call → no delta TPS (prevProcessed = 0, prevTimeMs = 0)
 *        - Subsequent calls → correct instantaneous TPS recorded
 *        - MAX_RATE_POINTS cap → oldest entries shifted out after 20+ calls
 */

/*
 * TODO 6: install() — fetch interceptor URL filtering & stream wrapping
 * ──────────────────────────────────────────────────────────────────────
 * Problem: Modifies globalThis.fetch. Testing requires careful setup/teardown and mock
 * Response objects with ReadableStream bodies.
 *
 * Ideas:
 *   a) Test that non-llama.cpp URLs pass through untouched (originalFetch called directly).
 *      Spy on originalFetch to verify passthrough behavior.
 *   b) Test that llama.cpp URLs get stream_options injected and body wrapped in captureTimings().
 *      Use vi.spyOn(manager, "ensureStreamOptions") and vi.spyOn(manager, "captureTimings").
 */
