/**
 * InferenceStatusManager — unified watcher for model loading, queue detection,
 * and live inference progress. Owns a single /models/sse connection and the
 * global fetch interceptor to provide a consistent working message.
 */

import { LlamaClient, type LlamaModelEvent } from "./client";

export type InferencePhase = 'loading' | 'downloading' | 'queued' | 'prefilling' | 'generating' | 'done';

// ─── State ──────────────────────────────────────────────────────────────

let _phase: InferencePhase | null = null;
let _queueTimeout: ReturnType<typeof setTimeout> | null = null;
let currentProgress: { total?: number; processed?: number; time_ms?: number; cache?: number } | null = null;
let prevProcessed = 0;
let prevTimeMs = 0;
let hasReceivedPrefill = false;
let uiRef: any = null;
let hasUIRef = false;

// Status bar key — shown in Pi's footer alongside other extensions (e.g. pi-token-speed)
const STATUS_KEY = "pi-llama-cpp";

// Frozen prefill snapshot captured when prefill completes.
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
const MIN_DELTA_MS = 1;

// Sanity cap for displayed TPS — no consumer GPU hits this during inference.
const MAX_REASONABLE_TPS = 50_000;

let originalFetch: typeof fetch | null = null;

// Generation-phase state — populated from `timings` in each SSE chunk
let genPredictedN = 0;
let genPredictedMs = 0;
let genCacheTokens = 0;
let hasGenerationData = false;
let genComplete = false;

// Server URLs to match against for the fetch interceptor.
const serverUrls: string[] = [];

// Loading state tracking
let loadingModel: string | null = null;
let loadingProgress: { ratio?: number; stage?: string; totalStages?: number } | null = null;
let downloadProgress: { done: number; total: number } | null = null;
let sseAbortController: AbortController | null = null;

// ─── Helpers ────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = units[0]!;
  for (let i = 1; i < units.length && value >= 1024; i++) {
    value /= 1024;
    unit = units[i]!;
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${unit}`;
}

function progressBar(ratio: number): string {
  const filled = Math.round(Math.max(0, Math.min(1, ratio)) * 20);
  return "█".repeat(filled) + "░".repeat(20 - filled);
}

function parseLoadProgress(data: unknown): { name: string; stageIndex: number; totalStages: number; stageRatio?: number } | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const value = data as Record<string, unknown>;
  const stageName = typeof value.current === "string" ? value.current : typeof value.stage === "string" ? value.stage : undefined;
  const stages = Array.isArray(value.stages) ? (value.stages.filter((s): s is string => typeof s === "string") as string[]) : [];
  const stageRatio = typeof value.value === "number" ? Math.max(0, Math.min(1, value.value)) : undefined;

  let stageIndex = 0;
  if (stageName && stages.length > 0) {
    stageIndex = Math.max(0, stages.indexOf(stageName));
  }

  return {
    name: stageName ? stageName.replaceAll("_", " ") : "model",
    stageIndex,
    totalStages: Math.max(stages.length, 1),
    stageRatio,
  };
}

function sumDownloadProgress(data: unknown): { done: number; total: number } | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  let done = 0, total = 0;
  for (const v of Object.values(data as Record<string, unknown>)) {
    if (typeof v !== "object" || v === null) continue;
    const e = v as { done?: unknown; total?: unknown };
    if (typeof e.done !== "number" || typeof e.total !== "number") continue;
    done += e.done;
    total += e.total;
  }
  return total > 0 ? { done, total } : undefined;
}

// ─── Manager ────────────────────────────────────────────────────────────

export class InferenceStatusManager {
  /**
   * Install the global fetch interceptor. Call once at extension init.
   */
  install(serverUrl?: string): void {
    if (originalFetch) return; // already installed
    originalFetch = globalThis.fetch;

    if (serverUrl) serverUrls.push(normalizeBaseUrl(serverUrl));

    const self = this;
    globalThis.fetch = async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input?.url ?? "";
      if (!self.isLlamaCppUrl(url)) {
        return originalFetch!(input, init);
      }

      self.ensureStreamOptions(input, init);

      const response = await originalFetch!(input, init);

      // Re-assert our working message immediately after the request is sent.
      // Pi's provider layer often overrides the working message when the fetch starts,
      // so we need to push our status again to prevent it from falling back to "Working...".
      self.updateWorkingMessage();

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
   * Connect to the /models/sse endpoint for real-time loading/download tracking.
   */
  connect(serverUrl: string, apiKey?: string): void {
    this.stopSse();
    const client = new LlamaClient(serverUrl, apiKey);
    const ac = new AbortController();
    sseAbortController = ac;

    void client.watch(this.handleModelEvent.bind(this), ac.signal).catch(() => {
      // SSE connection failed — loading tracking will rely on inference states instead.
      sseAbortController = null;
    });
  }

  private handleModelEvent(event: LlamaModelEvent): void {
    const modelId = event.model;
    if (!modelId) return;

    // Only process events for the model we're currently inferring with.
    if (loadingModel && modelId !== loadingModel) return;

    const data = event.data as Record<string, unknown> | undefined;

    // status_change / model_status — carries progress info during loading and downloads.
    if ((event.event === "status_change" || event.event === "model_status") && data) {
      const status = typeof data.status === "string" ? data.status : undefined;

      // Load progress: stages + current stage value.
      if (data.progress != null) {
        const loadProgress = parseLoadProgress(data.progress);
        if (loadProgress && loadProgress.stageRatio !== undefined) {
          _phase = 'loading';
          loadingProgress = {
            ratio: loadProgress.stageRatio,
            stage: loadProgress.name,
            totalStages: loadProgress.totalStages,
          };
          this.updateWorkingMessage();
          return;
        }

        // Download progress: per-URL done/total map.
        const downloadSum = sumDownloadProgress(data.progress);
        if (downloadSum && downloadSum.total > 0) {
          _phase = 'downloading';
          downloadProgress = downloadSum;
          this.updateWorkingMessage();
          return;
        }
      }

      if (status === "loading") {
        _phase = 'loading';
        this.updateWorkingMessage();
      } else if (status === "loaded" || status === "unloaded") {
        // If we were explicitly tracking loading, clear it now.
        if (_phase === 'loading' || _phase === 'downloading') {
          _phase = null;
          loadingProgress = null;
          downloadProgress = null;
          this.updateWorkingMessage();
        }
      }
    }

    // download_progress events carry per-URL done/total directly in data.
    if (event.event === "download_progress" && data) {
      const sum = sumDownloadProgress(data);
      if (sum && sum.total > 0) {
        _phase = 'downloading';
        downloadProgress = sum;
        this.updateWorkingMessage();
      }
    }
  }

  /**
   * Remove the fetch interceptor and disconnect SSE. Call on shutdown.
   */
  uninstall(): void {
    if (originalFetch) {
      globalThis.fetch = originalFetch;
      originalFetch = null;
    }
    this.stopSse();
    this.reset();
  }

  private stopSse(): void {
    if (sseAbortController) {
      sseAbortController.abort();
      sseAbortController = null;
    }
  }

  reset(): void {
    this.clearAllDisplay();
    this.resetForNewRequest();
    uiRef = null;
    hasUIRef = false;
    loadingModel = null;
    loadingProgress = null;
    downloadProgress = null;
  }

  /**
   * Update the tracked server URLs. Called when auth credentials change.
   */
  updateServerUrl(serverUrl: string): void {
    const normalized = normalizeBaseUrl(serverUrl);
    if (!serverUrls.includes(normalized)) {
      serverUrls.push(normalized);
    }
  }

  // ─── Public hooks for Pi events ──────────────────────────────────────

  /**
   * Called before each agent run / provider request.
   */
  onBeforeProviderRequest(ctx: { ui?: any; hasUI?: boolean }, model?: string): void {
    this.refreshUiRef(ctx);
    if (model) loadingModel = model;
    this.resetForNewRequest();
  }

  /**
   * Called at the start of each turn. Refreshes UI ref.
   */
  onTurnStart(ctx: { ui?: any; hasUI?: boolean }): void {
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

  /**
   * Polls the server /slots endpoint to detect if the request is queued.
   */
  async checkQueue(model?: string): Promise<void> {
    const baseUrl = serverUrls[serverUrls.length - 1];
    if (!baseUrl) return;

    // Use a timeout to ensure this poll never blocks the main request flow.
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), 500);

    try {
      const url = new URL(`${baseUrl}/slots`);
      if (model) url.searchParams.set("model", model);

      const response = await fetch(url.toString(), { signal: controller.signal });
      if (!response.ok) return;

      const slots = await response.json() as any[];
      if (!Array.isArray(slots) || slots.length === 0) return;

      const allBusy = slots.every((s: any) => s.is_processing === true);
      if (allBusy) {
        _phase = 'queued';
        this.updateWorkingMessage();
      }
    } catch {
      // Ignore polling errors or timeouts — fallback to timing heuristic.
    } finally {
      clearTimeout(id);
    }
  }

  private clearWorkingMessage(): void {
    if (uiRef && hasUIRef) {
      try { uiRef.setWorkingMessage(); } catch {}
    }
  }

  // ─── URL matching ────────────────────────────────────────────────────

  private isLlamaCppUrl(url: string): boolean {
    return serverUrls.some((s) => url.startsWith(s));
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
  public resetForNewRequest(): void {
    if (_queueTimeout) clearTimeout(_queueTimeout);
    _phase = null;
    currentProgress = null;
    prevProcessed = 0;
    prevTimeMs = 0;
    hasReceivedPrefill = false;
    rateHistory.length = 0;

    genPredictedN = 0;
    genPredictedMs = 0;
    genCacheTokens = 0;
    hasGenerationData = false;
    genComplete = false;

    prefillSnapshot = null;

    // Fallback: if no SSE data arrives within 2s, assume we are queued or server is slow.
    _queueTimeout = setTimeout(() => {
      if (_phase === null) {
        _phase = 'queued';
        this.updateWorkingMessage();
      }
    }, 2000);
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
              if (chunk.timings) {
                self.onTimings(chunk.timings as Record<string, unknown>);
              }

              // Continuously update the working message on every valid SSE chunk.
              // This prevents Pi from overriding it with its generic "Working..." status.
              self.updateWorkingMessage();
            } catch {
              // Ignore parse errors for non-JSON SSE lines
            }
          }

          controller.enqueue(value);
        }
        if (_queueTimeout) clearTimeout(_queueTimeout);
        _phase = 'done';
        self.clearWorkingMessage();
        controller.close();
      },
      cancel(reason?: any) {
        reader.cancel?.(reason);
      },
    });
  }

  private onPromptProgress(p: Record<string, unknown>): void {
    if (_queueTimeout) clearTimeout(_queueTimeout);
    _phase = 'prefilling';
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
  }

  /**
   * Called for every SSE chunk that carries a `timings` object.
   */
  private onTimings(t: Record<string, unknown>): void {
    if (_queueTimeout) clearTimeout(_queueTimeout);
    const predictedN = t.predicted_n as number | undefined;
    const predictedMs = t.predicted_ms as number | undefined;

    if (predictedN == null || predictedMs == null) return;

    // Transition to generating phase if prefill is complete or was skipped.
    const prefillComplete =
      currentProgress?.total != null &&
      currentProgress.processed !== undefined &&
      currentProgress.processed >= currentProgress.total;

    if (prefillComplete || !hasReceivedPrefill) {
      _phase = 'generating';
    }

    genPredictedN = predictedN;
    genPredictedMs = predictedMs;
    // cache_n is the total cached tokens for this request. Capture it from timings.
    const cacheN = t.cache_n as number | undefined;
    if (cacheN != null) {
      genCacheTokens = cacheN;
    }

    // Record start time on first timings chunk
    if (!hasGenerationData) {
      hasGenerationData = true;
    }
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
    // Loading / Downloading states (from /models/sse)
    if (_phase === 'loading' && loadingProgress) {
      const { ratio, stage, totalStages } = loadingProgress;
      const ratioVal = ratio ?? 0;
      const stageIdx = 1; // simplified stage index
      return `⏳ Loading ${stage || "model"} (stage ${stageIdx}/${totalStages || 1}) ${progressBar(ratioVal)} ${(ratioVal * 100).toFixed(0).padStart(3)}%`;
    }

    if (_phase === 'downloading' && downloadProgress) {
      const { done, total } = downloadProgress;
      const ratio = done / total;
      return `⏳ Downloading ${progressBar(ratio)} ${(ratio * 100).toFixed(0).padStart(3)}% · ${formatBytes(done)} / ${formatBytes(total)}`;
    }

    // Queued state
    if (_phase === 'queued') return "⏳ Waiting...";

    // If we've started a request but haven't seen prefill/gen yet,
    // show "Waiting..." instead of returning null (which triggers Pi's default "Working...").
    // This covers queueing, post-loading delays, and slow slot assignment.
    if (!hasReceivedPrefill && !hasGenerationData) {
      return "⏳ Waiting...";
    }

    // Only switch to generation stats AFTER prefill is complete (processed === total)
    const prefillComplete =
      currentProgress?.total != null &&
      currentProgress.processed !== undefined &&
      currentProgress.processed >= currentProgress.total;

    if (hasGenerationData && (prefillComplete || !hasReceivedPrefill)) {
      return this.getStatsMessage();
    }

    // Still in prefill — show progress bar.
    if (!hasReceivedPrefill) return "⏳ Waiting...";
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
      const etaSec = this.estimateEta(processed, currentProgress.total!);

      suffix = `${this.formatDuration(etaSec)} · ${tps}`;
    }

    // Append cache info when there are hits.
    if (cacheCount > 0) {
      const newTokens = Math.max((currentProgress.processed ?? 0) - cacheCount, 0);
      suffix += ` · ${cacheCount} cached / ${newTokens} new`;
    }

    return `Prefilling... ${bar} ${pct.toFixed(0).padStart(3)}%${suffix ? ` · ${suffix}` : ""}`;
  }

  // ─── Rate estimation helpers ────────────────────────────────────────

  /**
   * Compute instantaneous TPS from two delta measurements.
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
   * Formats the live token-generation status message shown after prefill completes.
   */
  private getStatsMessage(): string | null {
    if (!hasGenerationData || genPredictedN === 0) return "Generating...";

    // Use server-side GPU timing, not wall-clock.
    let tps = genPredictedMs > 0 ? (genPredictedN / genPredictedMs) * 1000 : 0;
    // Discard bogus spikes from early-chunk edge cases where predicted_ms rounds to near-zero.
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

  // ─── Status bar display (fixed values, not live-updating) ──────────────

  /**
   * Writes the status bar line via ctx.ui.setStatus().
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

/** Normalize a server URL for matching: strip trailing slashes and /v1 suffix. */
function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "").replace(/\/v1$/, "");
}
