/**
 * PrefillProgressManager — intercepts llama.cpp SSE responses to show prompt
 * processing progress in Pi's working message.
 *
 * Unlike the standalone pi-llama-cpp-stats extension, this uses known server
 * baseUrls from the Server instances so URL matching is exact (no guessing).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Server } from "./server";

// ─── State ──────────────────────────────────────────────────────────────

let currentProgress: { total?: number; processed?: number; time_ms?: number } | null = null;
let prevProcessed = 0;
let prevTimeMs = 0;
let hasReceivedPrefill = false;
let uiRef: any = null;
let hasUIRef = false;

// Track instantaneous TPS measurements for rate curve fitting
const rateHistory: { processed: number; tps: number }[] = [];
const MAX_RATE_POINTS = 20;
let originalFetch: typeof fetch | null = null;

export class PrefillProgressManager {
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
    currentProgress = null;
    prevProcessed = 0;
    prevTimeMs = 0;
    hasReceivedPrefill = false;
    rateHistory.length = 0;
    uiRef = null;
    hasUIRef = false;
  }

  // ─── Public hooks for Pi events ──────────────────────────────────────

  onBeforeAgentStart(ctx: { ui?: any; hasUI?: boolean }): void {
    if (ctx.ui) {
      uiRef = ctx.ui;
      hasUIRef = !!ctx.hasUI;
    }
  }

  onTurnEnd(ctx: { ui?: any; hasUI?: boolean }): void {
    this.clearWorkingMessage();
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
              if (chunk.prompt_progress) {
                self.onPromptProgress(chunk.prompt_progress as Record<string, unknown>);
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

    // Save previous values for delta TPS calculation
    if (currentProgress) {
      prevProcessed = currentProgress.processed ?? 0;
      prevTimeMs = currentProgress.time_ms ?? 0;
    }

    currentProgress = { total, processed, time_ms: timeMs };
    hasReceivedPrefill = true;

    // Record instantaneous TPS for curve fitting
    const deltaP = (processed ?? 0) - prevProcessed;
    const deltaT = (timeMs ?? 0) - prevTimeMs;
    if (deltaT > 0 && deltaP > 0) {
      rateHistory.push({ processed: processed ?? 0, tps: deltaP / (deltaT / 1000) });
      if (rateHistory.length > MAX_RATE_POINTS) rateHistory.shift();
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
    if (!hasReceivedPrefill) return null;
    if (!currentProgress?.total || currentProgress.processed === undefined) {
      return "Prefilling...";
    }

    // Restore default message when done
    if (currentProgress.total && currentProgress.processed === currentProgress.total) {
      this.clearWorkingMessage();
      return null;
    }

    const pct = (currentProgress.processed / currentProgress.total) * 100;
    const filled = Math.round((pct / 100) * 20);
    const bar = "█".repeat(filled) + "░".repeat(20 - filled);

    let suffix = "";
    if (currentProgress.time_ms && currentProgress.processed > 0) {
      const processed = currentProgress.processed;
      const total = currentProgress.total!;
      const timeMs = currentProgress.time_ms;
      const elapsedSec = timeMs / 1000;

      // Instantaneous TPS from delta
      const deltaP = processed - prevProcessed;
      const deltaT = timeMs - prevTimeMs;
      let tps: string;
      if (deltaT > 0 && deltaP > 0) {
        tps = `${(deltaP / (deltaT / 1000)).toFixed(1)} tok/s`;
      } else {
        tps = `${(processed / elapsedSec).toFixed(1)} tok/s`;
      }

      // ETA via rate curve model or fallback to average
      const etaSec = this.estimateEta(processed, total);
      suffix = `${this.formatDuration(etaSec)} · ${tps}`;
    }

    return `Prefilling... ${bar} ${pct.toFixed(0).padStart(3)}%${suffix ? ` · ${suffix}` : ""}`;
  }

  // ─── Rate estimation helpers ────────────────────────────────────────

  private estimateEta(processed: number, total: number): number {
    const fit = this.fitRateCurve();
    if (!fit) return 0;

    const { slope, intercept } = fit;

    // Flat curve — use average TPS
    if (Math.abs(slope) < 0.001) {
      const avgTps = rateHistory.reduce((s, p) => s + p.tps, 0) / rateHistory.length;
      return avgTps > 0 ? (total - processed) / avgTps : 0;
    }

    // Integral of 1/(slope*x+intercept) from processed to total
    const a = slope * total + intercept;
    const b = slope * processed + intercept;
    if (a <= 0 || b <= 0) {
      const avgTps = rateHistory.reduce((s, p) => s + p.tps, 0) / rateHistory.length;
      return avgTps > 0 ? (total - processed) / avgTps : 0;
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

  private formatDuration(seconds: number): string {
    if (seconds < 60) return `${Math.round(seconds)}s`;
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return `${m}m ${s}s`;
  }
}
