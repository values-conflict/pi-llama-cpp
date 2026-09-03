/**
 * InferenceStatusManager — unified watcher for model loading, queue detection,
 * and live inference progress. Owns a single /models/sse connection and the
 * global fetch interceptor to provide a consistent working message.
 */

import { LlamaClient, type LlamaModelEvent } from "./client";

export type InferencePhase = "error" | "loading" | "downloading" | "queued" | "prefilling" | "generating" | "done";

type ConnectionState = "active" | "ended-cleanly" | "ended-abruptly" | "error";

// ─── State ──────────────────────────────────────────────────────────────

let _phase: InferencePhase | null = null;
let _connectionState: ConnectionState | null = null;
let _lastError: string | null = null;
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

// Persisted final stats from the last completed turn (survives reset).
let finalPromptTokens: number | null = null;
let finalPromptMs: number | null = null;
let _finalPromptCached: number | null = null;
let finalPredictedTokens: number | null = null;
let finalPredictedMs: number | null = null;

// Track instantaneous TPS measurements for EMA-based TPS display (prefill)
const rateHistory: { tps: number }[] = [];
const MAX_RATE_POINTS = 50;

// Trajectory data points for ETA estimation: (new_tokens_processed, elapsed_ms)
// Used for cumulative average and curve-fit ETA models.
const trajectoryPoints: { newTokens: number; elapsedMs: number }[] = [];
const MAX_TRAJECTORY_POINTS = 100;

// Minimum trajectory points before attempting a curve-fit ETA.
const MIN_POINTS_FOR_CURVE = 5;

// ETA countdown state: absolute wall-clock time (Date.now()) when the ETA hits zero.
// Updated on each new progress event; display counts down from this on every render.
let etaTargetTime: number | null = null;
let etaModel: "cumulative" | "curve" | null = null;

// Exponential moving average smoothing factor for TPS display.
// Lower = more weight on recent measurements (adapts faster to slowdowns).
// 0.3 means latest sample is 30% of the EMA, smoothed history is 70%.
const EMA_ALPHA = 0.3;

// Minimum meaningful time delta (ms) to avoid bogus TPS from sub-ms precision.
const MIN_DELTA_MS = 1;

// Sanity cap for displayed TPS — no consumer GPU hits this during inference.
const MAX_REASONABLE_TPS = 50_000;

let originalFetch: typeof fetch | null = null;

// Generation-phase state — populated from `timings` in each SSE chunk
let genPredictedN = 0;
let genPredictedMs = 0;
let _genCacheTokens = 0;
let hasGenerationData = false;
let genComplete = false;

// Agentic loop tracking
let turnIndex: number | undefined;

// Compaction tracking — set via session_before_compact, cleared via session_compact.
// Pi's "Compacting context..." status indicator swallows setWorkingMessage() calls,
// so during compaction live progress is mirrored into the footer status bar instead.
let isCompacting = false;

// Label for live progress while compacting (🤏 = pinching the context down).
const COMPACT_LABEL = "🤏 Compacting… ";

// Server URLs to match against for the fetch interceptor.
const serverUrls: string[] = [];

// Sampling params captured from request body (deferred display).
let _samplingParams: { temperature?: number; topP?: number } | null = null;

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

function progressBar(ratio: number, prefilledRatio = 0): string {
	const width = 20;
	const filled = Math.floor(Math.max(0, Math.min(1, ratio)) * width);
	const prefilled = Math.floor(Math.max(0, Math.min(1, prefilledRatio)) * width);
	const processing = filled - prefilled;
	const remaining = width - filled;
	return `${"▒".repeat(prefilled)}${"█".repeat(processing)}${"░".repeat(remaining)} ${(ratio * 100).toFixed(0).padStart(3)}%`;
}

function parseLoadProgress(
	data: unknown,
): { name: string; stageIndex: number; totalStages: number; stageRatio?: number } | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	const value = data as Record<string, unknown>;
	const stageName =
		typeof value.current === "string" ? value.current : typeof value.stage === "string" ? value.stage : undefined;
	const stages = Array.isArray(value.stages)
		? (value.stages.filter((s): s is string => typeof s === "string") as string[])
		: [];
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
	let done = 0,
		total = 0;
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

export type OnModelLoadedCallback = (modelId: string) => void;

export class InferenceStatusManager {
	/**
	 * Called when a model transitions to "loaded" status via /models/sse.
	 * Use to trigger catalog refreshes so Pi picks up the real context size.
	 */
	onModelLoaded: OnModelLoadedCallback | null = null;

	/**
	 * Install the global fetch interceptor. Call once at extension init.
	 */
	install(serverUrl?: string): void {
		if (originalFetch) return; // already installed
		originalFetch = globalThis.fetch;

		if (serverUrl) serverUrls.push(normalizeBaseUrl(serverUrl));
		globalThis.fetch = async (input: any, init?: any) => {
			const url = typeof input === "string" ? input : (input?.url ?? "");
			if (!this.isLlamaCppUrl(url)) {
				return originalFetch!(input, init);
			}

			try {
				this.ensureStreamOptions(input, init);

				const response = await originalFetch!(input, init);

				// Re-assert our working message immediately after the request is sent.
				// Pi's provider layer often overrides the working message when the fetch starts,
				// so we need to push our status again to prevent it from falling back to "Working...".
				this.updateWorkingMessage();

				if (response.ok && response.body) {
					return new Response(this.captureTimings(response.body), {
						status: response.status,
						statusText: response.statusText,
						headers: new Headers(response.headers),
					});
				}
				return response;
			} catch (err) {
				_lastError = err instanceof Error ? err.message : String(err);
				_phase = "error";
				this.updateWorkingMessage();
				throw err; // still propagate so Pi handles retry/fallback
			}
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
					_phase = "loading";
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
					_phase = "downloading";
					downloadProgress = downloadSum;
					this.updateWorkingMessage();
					return;
				}
			}

			if (status === "loading") {
				_phase = "loading";
				this.updateWorkingMessage();
			} else if (status === "loaded" || status === "unloaded") {
				// If we were explicitly tracking loading, clear it now.
				if (_phase === "loading" || _phase === "downloading") {
					_phase = null;
					loadingProgress = null;
					downloadProgress = null;
					this.updateWorkingMessage();
				}
			}
			if (status === "loaded") {
				// Notify extension so it can refresh the catalog (real n_ctx is now known).
				this.onModelLoaded?.(modelId);
			}
		}

		// download_progress events carry per-URL done/total directly in data.
		if (event.event === "download_progress" && data) {
			const sum = sumDownloadProgress(data);
			if (sum && sum.total > 0) {
				_phase = "downloading";
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
		turnIndex = undefined;
		isCompacting = false;
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
	 * Called before each provider request.
	 */
	onBeforeProviderRequest(ctx: { ui?: any; hasUI?: boolean }, model?: string): void {
		this.refreshUiRef(ctx);
		if (model) loadingModel = model;
		this.resetForNewRequest();
	}

	/**
	 * Called at the start of each turn. Refreshes UI ref and stores turn index.
	 */
	onTurnStart(ctx: { ui?: any; hasUI?: boolean }, event?: { turnIndex?: number }): void {
		this.refreshUiRef(ctx);
		if (event?.turnIndex != null) turnIndex = event.turnIndex;
		// A normal turn starting means any prior compaction is over. Doubles as
		// cleanup if compaction failed and session_compact never fired.
		if (isCompacting) {
			isCompacting = false;
			this.updateWorkingMessage();
		}
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
		try {
			uiRef?.setWorkingMessage();
		} catch {}
	}

	/**
	 * Called when compaction begins (session_before_compact event).
	 */
	onCompactStart(ctx: { ui?: any; hasUI?: boolean }): void {
		this.refreshUiRef(ctx);
		isCompacting = true;
		this.updateWorkingMessage();
	}

	/**
	 * Called when compaction ends (session_compact / session_compact_failed events).
	 * Same cleanup as turn_end — no turn_end fires for compaction.
	 */
	onCompactEnd(ctx: { ui?: any; hasUI?: boolean }): void {
		this.refreshUiRef(ctx);
		isCompacting = false;

		// Mark generation as complete so status bar shows both prefill + gen together.
		if (hasGenerationData && genPredictedN > 0) {
			genComplete = true;
			this.updateStatusBar();
		}

		// Clear working message — status bar persists until next turn start / reset.
		try {
			uiRef?.setWorkingMessage();
		} catch {}
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

			const slots = (await response.json()) as any[];
			if (!Array.isArray(slots) || slots.length === 0) return;

			const allBusy = slots.every((s: any) => s.is_processing === true);
			if (allBusy) {
				_phase = "queued";
				this.updateWorkingMessage();
			}
		} catch {
			// Ignore polling errors or timeouts — fallback to timing heuristic.
		} finally {
			clearTimeout(id);
		}
	}

	// ─── URL matching ────────────────────────────────────────────────────

	private isLlamaCppUrl(url: string): boolean {
		return serverUrls.some((s) => url.startsWith(s));
	}

	// ─── Request body modification ───────────────────────────────────────

	private ensureStreamOptions(_input: any, init?: any): void {
		try {
			const body = init?.body;
			if (!body) return;

			const isString = typeof body === "string";
			const p = isString ? JSON.parse(body) : { ...body };

			// Capture sampling params for deferred display.
			_samplingParams = {
				temperature: typeof p.temperature === "number" ? p.temperature : undefined,
				topP: typeof p.top_p === "number" ? p.top_p : undefined,
			};

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
		_connectionState = null;
		_lastError = null;
		currentProgress = null;
		prevProcessed = 0;
		prevTimeMs = 0;
		hasReceivedPrefill = false;
		rateHistory.length = 0;
		trajectoryPoints.length = 0;
		etaTargetTime = null;
		etaModel = null;

		genPredictedN = 0;
		genPredictedMs = 0;
		_genCacheTokens = 0;
		hasGenerationData = false;
		genComplete = false;

		prefillSnapshot = null;
		_samplingParams = null;

		// Fallback: if no SSE data arrives within 2s, assume we are queued or server is slow.
		_queueTimeout = setTimeout(() => {
			if (_phase === null) {
				_phase = "queued";
				this.updateWorkingMessage();
			}
		}, 2000);
	}

	// ─── SSE stream interception ────────────────────────────────────────

	private captureTimings(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
		const reader = body.getReader();
		let buffer = "";
		const decoder = new TextDecoder();
		let sawDone = false;

		// Capture `this` for use inside the stream callback (arrow function)
		const self = this;

		return new ReadableStream({
			async start(controller) {
				_connectionState = "active";
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;

					buffer += decoder.decode(value, { stream: true });
					const lines = buffer.split("\n");
					buffer = lines.pop() || "";

					for (const line of lines) {
						if (!line.startsWith("data: ")) continue;
						const jsonStr = line.slice(6);
						if (jsonStr === "[DONE]") {
							sawDone = true;
							continue;
						}

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

				// Stream ended — persist final stats before resetting.
				if (hasGenerationData && genPredictedN > 0) {
					finalPredictedTokens = genPredictedN;
					finalPredictedMs = genPredictedMs;
				}
				if (prefillSnapshot) {
					finalPromptTokens = prefillSnapshot.totalTokens;
					finalPromptMs = prefillSnapshot.elapsedMs;
					_finalPromptCached = prefillSnapshot.cachedTokens;
				}

				if (_queueTimeout) clearTimeout(_queueTimeout);

				// Determine how the stream ended.
				if (sawDone) {
					_connectionState = "ended-cleanly";
				} else if (_phase === "prefilling" || _phase === "generating") {
					_connectionState = "ended-abruptly";
				} else {
					_connectionState = "ended-cleanly";
				}

				_phase = "done";
				self.updateWorkingMessage();
				controller.close();
			},
			cancel(reason?: any) {
				reader.cancel?.(reason);
			},
		});
	}

	private onPromptProgress(p: Record<string, unknown>): void {
		if (_queueTimeout) clearTimeout(_queueTimeout);
		_phase = "prefilling";
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

		// Record instantaneous TPS for EMA-based TPS display.
		const instTps = this.computeInstantaneousTps(processed ?? 0, prevProcessed, timeMs ?? 0, prevTimeMs);
		if (instTps != null) {
			rateHistory.push({ tps: instTps });
			if (rateHistory.length > MAX_RATE_POINTS) rateHistory.shift();
		}

		// Collect trajectory point for ETA estimation.
		// Track (new_tokens_processed, elapsed_ms) to model the slowdown curve.
		if (processed !== undefined && timeMs != null) {
			const cacheCount = cache ?? 0;
			const newTokens = Math.max(processed - cacheCount, 0);
			if (newTokens > 0) {
				trajectoryPoints.push({ newTokens, elapsedMs: timeMs });
				if (trajectoryPoints.length > MAX_TRAJECTORY_POINTS) trajectoryPoints.shift();
			}
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
			_phase = "generating";
		}

		genPredictedN = predictedN;
		genPredictedMs = predictedMs;
		// cache_n is the total cached tokens for this request. Capture it from timings.
		const cacheN = t.cache_n as number | undefined;
		if (cacheN != null) {
			_genCacheTokens = cacheN;
		}

		// Record start time on first timings chunk
		if (!hasGenerationData) {
			hasGenerationData = true;
		}
	}

	// ─── UI display ──────────────────────────────────────────────────────

	private updateWorkingMessage(): void {
		const msg = this.withCompactLabel(this.getProgressMessage());
		if (!msg || !uiRef || !hasUIRef) return;

		try {
			uiRef.setWorkingMessage(msg);
		} catch {
			// UI may not be available in all contexts
		}

		// Pi swallows setWorkingMessage() while its "Compacting context..." indicator
		// is active, so mirror live progress into the footer status bar instead.
		if (isCompacting) {
			try {
				uiRef.setStatus(STATUS_KEY, msg);
			} catch {
				// UI may not be available in all contexts
			}
		}
	}

	/**
	 * Labels progress messages so they're clearly compaction, not a normal turn.
	 */
	private withCompactLabel(msg: string | null): string | null {
		if (!msg || !isCompacting) return msg;
		if (msg.startsWith(COMPACT_LABEL.trimEnd())) return msg;
		if (msg === "⏳ Waiting...") return COMPACT_LABEL.trimEnd();
		return `${COMPACT_LABEL}${msg}`;
	}

	private getProgressMessage(): string | null {
		// Connection error — naturally cleared by any other phase transition.
		if (_phase === "error" && _lastError) {
			return `❌ Connection error: ${_lastError}`;
		}

		// Stream ended abruptly warning — only show if we haven't moved to a new phase.
		if (_connectionState === "ended-abruptly" && _phase !== "generating" && _phase !== "prefilling") {
			return "⚠ Stream ended unexpectedly — response may be incomplete";
		}

		// Loading / Downloading states (from /models/sse)
		if (_phase === "loading" && loadingProgress) {
			const { ratio, stage, totalStages } = loadingProgress;
			const ratioVal = ratio ?? 0;
			const stageIdx = 1; // simplified stage index
			return `⏳ Loading ${stage || "model"} (stage ${stageIdx}/${totalStages || 1}) ${progressBar(ratioVal)}`;
		}

		if (_phase === "downloading" && downloadProgress) {
			const { done, total } = downloadProgress;
			const ratio = done / total;
			return `⏳ Downloading ${progressBar(ratio)} · ${formatBytes(done)} / ${formatBytes(total)}`;
		}

		// Queued state
		if (_phase === "queued") {
			// While compacting, don't show stale stats from the last turn.
			if (isCompacting) return COMPACT_LABEL.trimEnd();

			// If we have prior final stats (from a previous turn in an agentic loop),
			// show them alongside the waiting message.
			if (finalPredictedTokens && finalPredictedMs) {
				const tps = finalPredictedMs > 0 ? (finalPredictedTokens / finalPredictedMs) * 1000 : 0;
				if (tps <= MAX_REASONABLE_TPS && Number.isFinite(tps)) {
					const parts: string[] = ["⏳ Waiting..."];
					if (finalPromptTokens && finalPromptMs) {
						parts.push(`Prompt: ${finalPromptTokens}t / ${this.formatDuration(finalPromptMs)}`);
					}
					parts.push(
						`Gen: ${finalPredictedTokens}t / ${this.formatDuration(finalPredictedMs)} @ ${tps.toFixed(1)} tok/s`,
					);
					return parts.join(" · ");
				}
			}
			return "⏳ Waiting...";
		}

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

		const cacheCount = currentProgress.cache ?? 0;
		const total = currentProgress.total!;
		const processed = currentProgress.processed ?? 0;

		const parts: string[] = [`Prefilling... ${progressBar(processed / total, cacheCount / total)}`];

		// Don't show TPS/ETA until actual prefill work has happened.
		// The initial progress update from llama.cpp fires before any decode,
		// with processed == cache hits and time_ms near zero — producing bogus
		// TPS like 50000.0 tok/s. Wait until we've processed enough tokens
		// and elapsed enough time for a meaningful rate.
		const MIN_PROC_FOR_RATE = 10;
		const MIN_ELAPSED_MS = 50;
		if (
			currentProgress.time_ms &&
			currentProgress.processed > cacheCount + MIN_PROC_FOR_RATE &&
			currentProgress.time_ms > MIN_ELAPSED_MS
		) {
			const processed = currentProgress.processed;
			const timeMs = currentProgress.time_ms;

			// ETA: recalculate target on new progress data, then count down from it.
			const _model = this.estimateEta(processed, currentProgress.total!);
			if (etaTargetTime != null && etaModel != null) {
				const now = Date.now();
				const etaMs = Math.max(0, etaTargetTime - now);
				const icon = etaModel === "curve" ? "📈" : "📊";
				const etaDate = new Date(now + etaMs);
				parts.push(
					`${icon} ${this.formatDuration(etaMs)} (${etaDate.toLocaleTimeString("en-US", { hour12: false })})`,
				);
			}

			// Instantaneous TPS from delta (falls back to EMA on bogus spikes).
			const instTps = this.computeInstantaneousTps(processed, prevProcessed, timeMs, prevTimeMs);
			let tps: string;
			if (instTps != null) {
				tps = `${instTps.toFixed(1)} tok/s`;
			} else {
				// Fallback to EMA-based TPS.
				tps = this.getEmiTps();
			}
			if (tps) {
				parts.push(tps);
			}
		}

		// Append cache info when there are hits.
		if (cacheCount > 0) {
			const newTokens = Math.max((currentProgress.processed ?? 0) - cacheCount, 0);
			parts.push(`${cacheCount} cached / ${newTokens} new`);
		}

		return parts.join(" · ");
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

	/**
	 * Compute the EMA-based TPS for display as a fallback when instantaneous
	 * TPS is unreliable.
	 */
	private getEmiTps(): string {
		if (rateHistory.length < 2) {
			return "... tok/s";
		}

		let emaTps = rateHistory[0]!.tps;
		for (let i = 1; i < rateHistory.length; i++) {
			emaTps = EMA_ALPHA * rateHistory[i]!.tps + (1 - EMA_ALPHA) * emaTps;
		}

		if (emaTps <= 0 || emaTps > MAX_REASONABLE_TPS) {
			return "... tok/s";
		}

		return `${emaTps.toFixed(1)} tok/s`;
	}

	/**
	 * Estimate remaining prefill time using a two-tier approach:
	 *
	 * 📊 Cumulative average (always available): uses overall processed/time ratio.
	 *    Naturally captures slowdown because cumulative average drops as prefill
	 *    degrades — no need to predict the curve, just extrapolate the observed rate.
	 *
	 * 📈 Quadratic curve fit (after MIN_POINTS_FOR_CURVE data points): fits
	 *    time = a·n + b·n² to the (new_tokens, elapsed_ms) trajectory via
	 *    least-squares regression. The quadratic term captures the O(n²) attention
	 *    cost growth as the KV cache fills. Extrapolates to effectiveTotal.
	 *
	 * Returns the model type used, or null if no estimate yet.
	 * Sets etaTargetTime (absolute wall-clock ms) for countdown display.
	 */
	private estimateEta(processed: number, total: number): "cumulative" | "curve" | null {
		const cacheCount = currentProgress?.cache ?? 0;
		const elapsedMs = currentProgress?.time_ms ?? 0;

		// New (non-cached) tokens: these are the ones that actually cost time.
		const currentNewTokens = Math.max(processed - cacheCount, 0);
		const totalNewTokens = Math.max(total - cacheCount, 0);
		const remainingNewTokens = Math.max(totalNewTokens - currentNewTokens, 0);

		if (remainingNewTokens <= 0 || currentNewTokens <= 0) return null;
		if (elapsedMs <= 0) return null;

		// Try curve-fit first if we have enough data points.
		if (trajectoryPoints.length >= MIN_POINTS_FOR_CURVE) {
			const curveEta = this.fitQuadraticEta(
				trajectoryPoints,
				currentNewTokens,
				elapsedMs,
				totalNewTokens,
				remainingNewTokens,
			);
			if (curveEta != null && curveEta > 0) {
				etaTargetTime = Date.now() + curveEta;
				etaModel = "curve";
				return "curve";
			}
		}

		// Fallback to cumulative average.
		// Cumulative TPS naturally captures slowdown — as prefill degrades,
		// the average drops and the ETA grows accordingly.
		const cumulativeTps = (currentNewTokens / elapsedMs) * 1000; // tokens per second
		if (cumulativeTps <= 0) return null;
		const etaMs = (remainingNewTokens / cumulativeTps) * 1000;
		etaTargetTime = Date.now() + etaMs;
		etaModel = "cumulative";
		return "cumulative";
	}

	/**
	 * Fit time = a·n + b·n² to trajectory points via least-squares (through origin),
	 * then extrapolate to estimate remaining time.
	 *
	 * x-axis: new (non-cached) tokens processed
	 * y-axis: elapsed time in ms
	 *
	 * The model is forced through the origin (0 tokens → 0 time). The linear term
	 * captures per-token overhead (tokenization, sampling, memory ops) and the
	 * quadratic term captures attention cost growth as KV cache fills.
	 */
	private fitQuadraticEta(
		points: { newTokens: number; elapsedMs: number }[],
		currentNew: number,
		elapsedMs: number,
		totalNew: number,
		remainingNew: number,
	): number | null {
		// Build normal equations for time = a·x + b·x² (through origin).
		// Minimize Σ(t_i - a·x_i - b·x_i²)²
		// Normal equations:
		//   a·Σx² + b·Σx³ = Σ(x·t)
		//   a·Σx³ + b·Σx⁴ = Σ(x²·t)
		let sumX2 = 0,
			sumX3 = 0,
			sumX4 = 0,
			sumXT = 0,
			sumX2T = 0;

		for (const p of points) {
			const x = p.newTokens;
			const t = p.elapsedMs;
			const x2 = x * x;
			const x3 = x2 * x;
			const x4 = x3 * x;
			sumX2 += x2;
			sumX3 += x3;
			sumX4 += x4;
			sumXT += x * t;
			sumX2T += x2 * t;
		}

		const det = sumX2 * sumX4 - sumX3 * sumX3;
		if (Math.abs(det) < 1e-10) return null; // singular matrix

		const aCoeff = (sumXT * sumX4 - sumX2T * sumX3) / det;
		const bCoeff = (sumX2 * sumX2T - sumX3 * sumXT) / det;

		// Sanity: quadratic coeff must be positive (attention cost grows).
		// Linear coeff can be slightly negative if quadratic dominates (very long prompts).
		if (bCoeff <= 0 || !Number.isFinite(aCoeff) || !Number.isFinite(bCoeff)) return null;

		// Extrapolate: predict total elapsed time when all new tokens are processed.
		const predictedTotalMs = aCoeff * totalNew + bCoeff * totalNew * totalNew;
		const etaMs = predictedTotalMs - elapsedMs;

		// Sanity: ETA should be positive and not wildly off from cumulative average.
		// Cap at 10x the cumulative-average estimate to avoid bad extrapolation.
		const cumulativeEta = (remainingNew / ((currentNew / elapsedMs) * 1000)) * 1000;
		if (etaMs <= 0 || etaMs > cumulativeEta * 10) {
			return null; // curve fit is nonsense, fall back to cumulative
		}

		return etaMs;
	}

	/**
	 * Formats the live token-generation status message shown after prefill completes.
	 */
	private getStatsMessage(): string | null {
		if (!hasGenerationData || genPredictedN === 0) return "Generating...";

		// Use server-side GPU timing, not wall-clock.
		const tps = genPredictedMs > 0 ? (genPredictedN / genPredictedMs) * 1000 : 0;
		// Discard bogus spikes from early-chunk edge cases where predicted_ms rounds to near-zero.
		if (tps > MAX_REASONABLE_TPS || !Number.isFinite(tps)) return "Generating...";

		// Build the parts of the message.
		const parts: string[] = [];

		// Turn counter for agentic loops (0-based from Pi's turn_start event).
		if (turnIndex !== undefined && turnIndex > 0) {
			parts.push(`Turn ${turnIndex}`);
		}

		// Use formatDuration for consistent time display.
		const elapsedStr = this.formatDuration(genPredictedMs);
		parts.push(`🤔 ${tps.toFixed(1)} tok/s · ${genPredictedN} tokens in ${elapsedStr}`);

		return parts.join(" · ");
	}

	private formatDuration(ms: number): string {
		if (ms < 1000) return `${Math.round(ms)}ms`;
		const seconds = ms / 1000;
		if (seconds < 60) return `${seconds.toFixed(1)}s`;
		const m = Math.floor(seconds / 60);
		const s = Math.floor(seconds % 60); // this would be more accurate as "Math.round" but then we'll sometimes get "2m 60s" which looks insane (TODO maybe we should pre-round "seconds" before splitting it up to fix that?)
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
				`Prefill: ${totalTokens} tok${cachedTokens > 0 ? `, ${cachedTokens} cached, ${newTokens} new` : ""}, ${this.formatDuration(elapsedMs)} @ ${tps.toFixed(1)} tok/s`,
			);
		}

		// Generation stats — shown after generation completes (genComplete flag),
		// or live while compacting (status bar is the only visible channel then).
		if ((genComplete || isCompacting) && hasGenerationData && genPredictedN > 0) {
			const tps = genPredictedMs > 0 ? (genPredictedN / genPredictedMs) * 1000 : 0;
			if (tps <= MAX_REASONABLE_TPS && Number.isFinite(tps)) {
				parts.push(
					`Gen: ${genPredictedN} tokens in ${this.formatDuration(genPredictedMs)} @ ${tps.toFixed(1)} tok/s`,
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
			try {
				uiRef.setWorkingMessage();
			} catch {}
			try {
				uiRef.setStatus(STATUS_KEY, undefined);
			} catch {}
		}
	}
}

/** Normalize a server URL for matching: strip trailing slashes and /v1 suffix. */
function normalizeBaseUrl(url: string): string {
	return url.replace(/\/+$/, "").replace(/\/v1$/, "");
}
