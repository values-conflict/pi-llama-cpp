/**
 * InferenceStatusManager — intercepts llama.cpp SSE responses to show prompt
 * processing progress and live token-generation stats in Pi's working message.
 *
 * Unlike the standalone pi-llama-cpp-stats extension, this uses known server
 * baseUrls from the Server instances so URL matching is exact (no guessing).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Server } from "./server";

// ─── State ──────────────────────────────────────────────────────────────

let currentProgress: { total?: number; processed?: number; time_ms?: number; cache?: number } | null = null;
let prevProcessed = 0;
let prevTimeMs = 0;
let hasReceivedPrefill = false;
let uiRef: any = null;
let hasUIRef = false;

// Status bar key — shown in Pi's footer alongside other extensions (e.g. pi-token-speed)
const STATUS_KEY = "pi-llama-cpp";

// Frozen prefill snapshot captured when prefill completes.
// Used for the status bar so fixed values persist across generation/turn-end phases.
let prefillSnapshot: {
  totalTokens: number;
  cachedTokens: number;
  newTokens: number;
  elapsedMs: number;
} | null = null;

// Track instantaneous TPS measurements for rate curve fitting (prefill)
const rateHistory: { processed: number; tps: number }[] = [];
const MAX_RATE_POINTS = 20;

// Minimum meaningful time delta (ms) to avoid bogus TPS from sub-ms precision.
// Two SSE chunks can share the same millisecond timestamp on fast GPUs,
// producing deltaT ≈ 0 and TPS in the hundreds of thousands.
const MIN_DELTA_MS = 1;

// Sanity cap for displayed TPS — no consumer GPU hits this during inference.
// Catches unit-mismatch bugs (us vs ms) or floating-point edge cases.
const MAX_REASONABLE_TPS = 50_000;

let originalFetch: typeof fetch | null = null;

// Generation-phase state — populated from `timings` in each SSE chunk
let genPredictedN = 0;
let genPredictedMs = 0;
let genCacheTokens = 0; // total cached tokens (from timings.cache_n)
let genStartTime = 0; // Date.now() when first timings chunk arrives
let hasGenerationData = false;
let genComplete = false; // set true on turn end — gates Gen stats in status bar

export class InferenceStatusManager {
  private servers: Server[];

  constructor(servers: Server[]) {
    this.servers = servers;
  }

  /**
   * Install the global fetch interceptor. Call once at extension init.
   */
  install(): void {
    if (originalFetch) return; // already installed
    originalFetch = globalThis.fetch;

    const self = this;
    globalThis.fetch = async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input?.url ?? "";
      if (!self.isLlamaCppUrl(url)) {
        return originalFetch!(input, init);
      }

      self.ensureStreamOptions(input, init);

      const response = await originalFetch!(input, init);

      if (response.ok && response.body) {
        return new Response(self.captureTimings(response.body), {
          status: response.status,
          statusText: response.statusText,
          headers: new Headers(response.headers),
        });
      }
      return response;
    };
  }

  /**
   * Remove the fetch interceptor. Call on shutdown.
   */
  uninstall(): void {
    if (originalFetch) {
      globalThis.fetch = originalFetch;
      originalFetch = null;
    }
    this.reset();
  }

  reset(): void {
    // Clear display before wiping state (uiRef is still valid here).
    this.clearAllDisplay();

    this.resetForNewRequest();
    uiRef = null;
    hasUIRef = false;
  }

  // ─── Public hooks for Pi events ──────────────────────────────────────

  /**
   * Called before each agent run. Also used as fallback for turn_start
   * to ensure UI ref stays valid across multi-turn agentic loops.
   */
  onBeforeAgentStart(ctx: { ui?: any; hasUI?: boolean }): void {
    this.refreshUiRef(ctx);
  }

  /**
   * Called at the start of each turn. Refreshes UI ref in case Pi fires
   * multiple agent runs within an agentic loop (e.g., after tool execution).
   */
  onTurnStart(ctx: { ui?: any; hasUI?: boolean }): void {
    // Always refresh the UI ref when a new turn starts. In agentic loops
    // (tool calls, multi-step reasoning) Pi may provide a different context,
    // so we need to stay in sync.
    this.refreshUiRef(ctx);
  }

  private refreshUiRef(ctx: { ui?: any; hasUI?: boolean }): void {
    if (ctx.ui) {
      uiRef = ctx.ui;
      hasUIRef = !!ctx.hasUI;
    }
  }

  onTurnEnd(_ctx: { ui?: any; hasUI?: boolean }): void {
    // Mark generation as complete so status bar shows both prefill + gen together.
    if (hasGenerationData && genPredictedN > 0) {
      genComplete = true;
      this.updateStatusBar();
    }

    // Clear working message — status bar persists until next turn start / reset.
    try { uiRef?.setWorkingMessage(); } catch {}
  }

  private clearWorkingMessage(): void {
    if (uiRef && hasUIRef) {
      try { uiRef.setWorkingMessage(); } catch {}
    }
  }

  // ─── URL matching ────────────────────────────────────────────────────

  private isLlamaCppUrl(url: string): boolean {
    return this.servers.some((s) => url.startsWith(s.baseUrl));
  }

  // ─── Request body modification ───────────────────────────────────────

  private ensureStreamOptions(input: any, init?: any): void {
    try {
      let body = init?.body;
      if (!body) return;

      const isString = typeof body === "string";
      const p = isString ? JSON.parse(body) : { ...body };

      // Ensure stream_options.include_usage for token accounting
      if (!p.stream_options) {
        p.stream_options = { include_usage: true };
      } else if (!p.stream_options.include_usage) {
        p.stream_options.include_usage = true;
      }

      // Always request prompt progress and per-token timings.
      // The event handler (EventManager.onBeforeProviderRequest) sets these too,
      // but Pi may modify the payload afterwards. This interceptor is the last
      // line of defence — if either flag is missing, llama.cpp won't emit the
      // SSE fields we need for prefill bars or generation TPS.
      p.return_progress = true;
      p.timings_per_token = true;

      const newBody = JSON.stringify(p);
      if (isString) {
        init.body = newBody;
      } else {
        Object.assign(body, p);
      }
    } catch {
      // Ignore parse errors — not a JSON body
    }
  }

  /**
   * Resets per-request state so each new provider call starts fresh.
   */
  private resetForNewRequest(): void {
    currentProgress = null;
    prevProcessed = 0;
    prevTimeMs = 0;
    hasReceivedPrefill = false;
    rateHistory.length = 0;

    genPredictedN = 0;
    genPredictedMs = 0;
    genCacheTokens = 0;
    genStartTime = 0;
    hasGenerationData = false;
    genComplete = false;

    prefillSnapshot = null;
  }

  // ─── SSE stream interception ────────────────────────────────────────

  private captureTimings(
    body: ReadableStream<Uint8Array>,
  ): ReadableStream<Uint8Array> {
    const reader = body.getReader();
    let buffer = "";
    const decoder = new TextDecoder();

    // Capture `this` for use inside the stream callback (arrow function)
    const self = this;

    return new ReadableStream({
      async start(controller) {
        self.resetForNewRequest();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const jsonStr = line.slice(6);
            if (jsonStr === "[DONE]") continue;

            try {
              const chunk = JSON.parse(jsonStr);

              // Prompt prefill progress — shown during prompt processing
              if (chunk.prompt_progress) {
                self.onPromptProgress(chunk.prompt_progress as Record<string, unknown>);
              }

              // Token-generation timings — shown after prefill completes.
              // llama.cpp sends this in every chat-completion chunk when
              // `timings_per_token: true` is set (pi-llama-cpp always does).
              if (chunk.timings) {
                self.onTimings(chunk.timings as Record<string, unknown>);
              }
            } catch {
              // Ignore parse errors for non-JSON SSE lines
            }
          }

          controller.enqueue(value);
        }
        controller.close();
      },
      cancel(reason?: any) {
        reader.cancel?.(reason);
      },
    });
  }

  private onPromptProgress(p: Record<string, unknown>): void {
    const total = p.total as number | undefined;
    const processed = p.processed as number | undefined;
    const timeMs = p.time_ms as number | undefined;
    const cache = (p.cache as number) ?? 0;

    // Save previous values for delta TPS calculation
    if (currentProgress) {
      prevProcessed = currentProgress.processed ?? 0;
      prevTimeMs = currentProgress.time_ms ?? 0;
    }

    currentProgress = { total, processed, time_ms: timeMs, cache };
    hasReceivedPrefill = true;

    // Record instantaneous TPS for curve fitting.
    const instTps = this.computeInstantaneousTps(
      processed ?? 0,
      prevProcessed,
      timeMs ?? 0,
      prevTimeMs,
    );
    if (instTps != null) {
      rateHistory.push({ processed: processed ?? 0, tps: instTps });
      if (rateHistory.length > MAX_RATE_POINTS) rateHistory.shift();
    }

    // Capture frozen prefill snapshot when prefill completes.
    const isPrefillComplete = total != null && processed !== undefined && processed >= total;
    if (isPrefillComplete && !prefillSnapshot) {
      const cacheCount = currentProgress.cache ?? 0;
      prefillSnapshot = {
        totalTokens: total,
        cachedTokens: cacheCount,
        newTokens: Math.max(processed - cacheCount, 0),
        elapsedMs: timeMs ?? 0,
      };
      this.updateStatusBar(); // show final prefill stats in status bar
    }

    this.updateWorkingMessage();
  }

  /**
   * Called for every SSE chunk that carries a `timings` object.
   *
   * llama.cpp reports cumulative generation stats here:
   * - predicted_n: total output tokens generated so far
   * - predicted_ms: wall-clock ms spent generating those tokens
   */
  private onTimings(t: Record<string, unknown>): void {
    const predictedN = t.predicted_n as number | undefined;
    const predictedMs = t.predicted_ms as number | undefined;

    if (predictedN == null || predictedMs == null) return;

    genPredictedN = predictedN;
    genPredictedMs = predictedMs;
    // cache_n is the total cached tokens for this request. Capture it from timings.
    const cacheN = t.cache_n as number | undefined;
    if (cacheN != null) {
      genCacheTokens = cacheN;
    }

    // Record start time on first timings chunk
    if (!hasGenerationData) {
      genStartTime = Date.now();
      hasGenerationData = true;
    }

    this.updateWorkingMessage();
  }

  // ─── UI display ──────────────────────────────────────────────────────

  private updateWorkingMessage(): void {
    const msg = this.getProgressMessage();
    if (!msg || !uiRef || !hasUIRef) return;

    try {
      uiRef.setWorkingMessage(msg);
    } catch {
      // UI may not be available in all contexts
    }
  }

  private getProgressMessage(): string | null {
    // Nothing to show yet — prefill hasn't started and no timings arrived.
    if (!hasReceivedPrefill && !hasGenerationData) return null;

    // Only switch to generation stats AFTER prefill is complete (processed === total)
    // or when we have timings but never received any prompt_progress data at all
    // (some llama.cpp builds may not support it).
    const prefillComplete =
      currentProgress?.total != null &&
      currentProgress.processed !== undefined &&
      currentProgress.processed >= currentProgress.total;

    if (hasGenerationData && (prefillComplete || !hasReceivedPrefill)) {
      return this.getStatsMessage();
    }

    // Still in prefill — show progress bar.
    if (!hasReceivedPrefill) return null;
    if (!currentProgress?.total || currentProgress.processed === undefined) {
      return "Prefilling...";
    }

    // Prefill complete — transition to "Generating..." until first timings chunk
    if (currentProgress.total && currentProgress.processed === currentProgress.total) {
      return hasGenerationData ? this.getStatsMessage() : "Generating...";
    }

    // Adjust progress to reflect actual work (not cached tokens), matching upstream.
    const cacheCount = currentProgress.cache ?? 0;
    const actualTotal = Math.max(currentProgress.total! - cacheCount, 1);
    const actualDone = Math.max((currentProgress.processed ?? 0) - cacheCount, 0);
    const pct = (actualDone / actualTotal) * 100;
    const filled = Math.round((pct / 100) * 20);
    const bar = "█".repeat(filled) + "░".repeat(20 - filled);

    let suffix = "";
    if (currentProgress.time_ms && currentProgress.processed > 0) {
      const processed = currentProgress.processed;
      const total = currentProgress.total!;
      const timeMs = currentProgress.time_ms;
      const elapsedSec = timeMs / 1000;

      // Instantaneous TPS from delta (falls back to average on bogus spikes).
      const instTps = this.computeInstantaneousTps(
        processed,
        prevProcessed,
        timeMs,
        prevTimeMs,
      );
      let tps: string;
      if (instTps != null) {
        tps = `${instTps.toFixed(1)} tok/s`;
      } else {
        // Fallback to average TPS. Guard against tiny elapsedSec and cap outliers.
        const avgTps = elapsedSec >= 0.001 ? processed / elapsedSec : 0;
        tps = `${Math.min(avgTps, MAX_REASONABLE_TPS).toFixed(1)} tok/s`;
      }

      // ETA via rate curve model or fallback to average
      // Based on actual remaining work (total - cache), not raw token count.
      const etaSec = this.estimateEta(processed, currentProgress.total!);

      suffix = `${this.formatDuration(etaSec)} · ${tps}`;
    }

    // Append cache info when there are hits.
    let cacheSuffix = "";
    if (cacheCount > 0) {
      const newTokens = Math.max((currentProgress.processed ?? 0) - cacheCount, 0);
      suffix += ` · ${cacheCount} cached / ${newTokens} new`;
    }

    return `Prefilling... ${bar} ${pct.toFixed(0).padStart(3)}%${suffix ? ` · ${suffix}` : ""}`;
  }

  // ─── Rate estimation helpers ────────────────────────────────────────

  /**
   * Compute instantaneous TPS from two delta measurements.
   *
   * Returns null when the time delta is too small (sub-ms precision can produce
   * bogus spikes) or when no tokens were processed, or when the value exceeds
   * a sanity cap that catches unit-mismatch bugs and floating-point edge cases.
   */
  private computeInstantaneousTps(
    currentProcessed: number,
    prevProc: number,
    currentTimeMs: number,
    prevTime: number,
  ): number | null {
    const deltaP = currentProcessed - prevProc;
    const deltaT = currentTimeMs - prevTime;
    if (deltaT < MIN_DELTA_MS || deltaP <= 0) return null;

    const tps = deltaP / (deltaT / 1000);
    // Sanity cap — discard values that no real GPU could produce.
    return tps <= MAX_REASONABLE_TPS ? tps : null;
  }



  private estimateEta(processed: number, total: number): number {
    // ETA should be based on actual remaining work (total - cache), not raw token count.
    const cacheCount = currentProgress?.cache ?? 0;
    const effectiveTotal = Math.max(total - cacheCount, processed);

    if (processed >= effectiveTotal) return 0;

    const fit = this.fitRateCurve();
    if (!fit) {
      // Fallback: use average TPS over actual work.
      const avgTps = rateHistory.reduce((s, p) => s + p.tps, 0) / rateHistory.length;
      return avgTps > 0 ? (effectiveTotal - processed) / avgTps : 0;
    }

    const { slope, intercept } = fit;

    // Flat curve — use average TPS over actual work.
    if (Math.abs(slope) < 0.001) {
      const avgTps = rateHistory.reduce((s, p) => s + p.tps, 0) / rateHistory.length;
      return avgTps > 0 ? (effectiveTotal - processed) / avgTps : 0;
    }

    // Integral of 1/(slope*x+intercept) from processed to effectiveTotal
    const a = slope * effectiveTotal + intercept;
    const b = slope * processed + intercept;
    if (a <= 0 || b <= 0) {
      const avgTps = rateHistory.reduce((s, p) => s + p.tps, 0) / rateHistory.length;
      return avgTps > 0 ? (effectiveTotal - processed) / avgTps : 0;
    }

    if (a / b <= 0) return 0;
    return Math.log(a / b) / slope;
  }

  private fitRateCurve(): { slope: number; intercept: number } | null {
    const n = rateHistory.length;
    if (n < 2) return null;

    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    for (const pt of rateHistory) {
      sumX += pt.processed;
      sumY += pt.tps;
      sumXY += pt.processed * pt.tps;
      sumX2 += pt.processed * pt.processed;
    }

    const denom = n * sumX2 - sumX * sumX;
    if (denom === 0) return null;

    const slope = (n * sumXY - sumX * sumY) / denom;
    const intercept = (sumY - slope * sumX) / n;
    return { slope, intercept };
  }

  /**
   * Formats the live token-generation status message shown after prefill
   * completes. Uses server-reported timing data from llama.cpp's `timings`
   * object — matches upstream UI calculation: (predicted_n / predicted_ms) * 1000.
   */
  private getStatsMessage(): string | null {
    if (!hasGenerationData || genPredictedN === 0) return "Generating...";

    // Use server-side GPU timing, not wall-clock. Wall clock includes network
    // latency and Pi processing overhead, making TPS appear artificially low.
    let tps = genPredictedMs > 0 ? (genPredictedN / genPredictedMs) * 1000 : 0;
    // Discard bogus spikes from early-chunk edge cases where predicted_ms
    // rounds to near-zero on fast GPUs, or unit-mismatch bugs.
    if (tps > MAX_REASONABLE_TPS || !isFinite(tps)) return "Generating...";
    const elapsedSec = genPredictedMs / 1000;

    return `🤔 ${tps.toFixed(1)} tok/s · ${genPredictedN} tokens in ${elapsedSec.toFixed(1)}s`;
  }

  private formatDuration(seconds: number): string {
    if (seconds < 60) return `${Math.round(seconds)}s`;
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return `${m}m ${s}s`;
  }

  // ─── Status bar display (fixed values, not live-updating) ─────────────
  // All status-bar format strings live here alongside working-message formatters
  // so layout/tweaks can be made in one place.

  /**
   * Writes the status bar line via ctx.ui.setStatus().
   *
   * Phases:
   * - Generation active: shows final prefill stats only.
   * - Turn end (complete): shows both prefill + generation stats together.
   */
  private updateStatusBar(): void {
    if (!uiRef || !hasUIRef) return;

    const parts: string[] = [];

    // Prefill snapshot — shown as soon as it is captured, persists through gen phase.
    if (prefillSnapshot) {
      const { totalTokens, cachedTokens, newTokens, elapsedMs } = prefillSnapshot;
      const tps = elapsedMs > 0 ? ((totalTokens - cachedTokens) / elapsedMs) * 1000 : 0;
      parts.push(
        `Prefill: ${totalTokens} tok${cachedTokens > 0 ? `, ${cachedTokens} cached, ${newTokens} new` : ""}, ${(elapsedMs / 1000).toFixed(1)}s @ ${tps.toFixed(1)} tok/s`,
      );
    }

    // Generation stats — shown only after generation is complete (genComplete flag).
    if (genComplete && hasGenerationData && genPredictedN > 0) {
      const tps = genPredictedMs > 0 ? (genPredictedN / genPredictedMs) * 1000 : 0;
      if (tps <= MAX_REASONABLE_TPS && isFinite(tps)) {
        parts.push(
          `Gen: ${genPredictedN} tokens in ${(genPredictedMs / 1000).toFixed(1)}s @ ${tps.toFixed(1)} tok/s`,
        );
      }
    }

    const text = parts.length > 0 ? parts.join(" · ") : undefined;
    try {
      uiRef.setStatus(STATUS_KEY, text);
    } catch {
      // UI may not be available in all contexts
    }
  }

  /**
   * Clears both the working message and status bar. Called on reset / turn start.
   */
  private clearAllDisplay(): void {
    if (uiRef && hasUIRef) {
      try { uiRef.setWorkingMessage(); } catch {}
      try { uiRef.setStatus(STATUS_KEY, undefined); } catch {}
    }
  }
}
