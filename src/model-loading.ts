/**
 * ModelLoadingWatcher — maintains a persistent /models/sse connection to detect
 * loading/download state transitions in real-time. Falls back to polling if SSE
 * is unavailable (non-router mode or server unreachable).
 */

import { LlamaClient, type LlamaModelEvent } from "./client";

function normalizeBaseUrl(url: string): string {
	return url.replace(/\/+$/, "").replace(/\/v1$/, "");
}

const POLL_INTERVAL_MS = 500;
const TIMEOUT_MS = 60_000;
const GRACE_PERIOD_MS = 2000; // how long to poll before giving up on unloaded state

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

/** Build a progress bar string: ████████░░░░░░░░░░░░ */
function progressBar(ratio: number): string {
	const filled = Math.round(Math.max(0, Math.min(1, ratio)) * 20);
	return "█".repeat(filled) + "░".repeat(20 - filled);
}

/** Parse load progress from SSE status_change data.progress. */
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

/** Sum done/total from a download progress map. */
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

export class ModelLoadingWatcher {
	private client: LlamaClient | null = null;
	private _pendingServer: string | undefined;
	private _pendingApiKey: string | undefined;
	private sseAbortController: AbortController | null = null;
	private pollTimerId: ReturnType<typeof setInterval> | null = null;
	private timeoutId: ReturnType<typeof setTimeout> | null = null;
	private uiRef: any = null;
	private hasUIRef = false;

	// Track which model is currently being watched for loading.
	private watchingModel = "";

	// Timer to clear the working message after loaded state.
	private clearTimerId: ReturnType<typeof setTimeout> | null = null;

	/** Set the UI context for showing working messages. */
	setUiContext(ui: any, hasUI: boolean): void {
		this.uiRef = ui;
		this.hasUIRef = !!hasUI;
	}

	/** Connect or reconnect the persistent SSE connection. Call at plugin load and when server URL changes. */
	connect(serverUrl: string, apiKey?: string): void {
		const currentServer = this.client?.serverUrl;
		if (currentServer === normalizeBaseUrl(serverUrl)) return; // no change

		this.stop();
		this._pendingServer = serverUrl;
		this._pendingApiKey = apiKey;
		this.client = new LlamaClient(serverUrl, apiKey);
		const ac = new AbortController();
		this.sseAbortController = ac;

		void this.client.watch(this.handleEvent.bind(this), ac.signal).catch(() => {
			this.sseAbortController = null;
			this.client = null;
			if (this.watchingModel && this.hasUIRef) {
				this.startPollFallback(serverUrl, apiKey);
			}
		});
	}

	/** Disconnect the persistent SSE connection and stop all watchers. Call on shutdown. */
	disconnect(): void {
		this.stop();
	}

	private handleEvent(event: LlamaModelEvent): void {
		const modelId = event.model;
		if (!modelId) return;

		// Only process events for the model we're watching.
		if (this.watchingModel && modelId !== this.watchingModel) return;

		const data = event.data as Record<string, unknown> | undefined;

		// status_change / model_status — carries progress info during loading and downloads.
		if ((event.event === "status_change" || event.event === "model_status") && data) {
			const status = typeof data.status === "string" ? data.status : undefined;

			// Load progress: stages + current stage value (e.g., text_model, mmproj_model).
			if (data.progress != null) {
				const loadProgress = parseLoadProgress(data.progress);
				if (loadProgress && loadProgress.stageRatio !== undefined) {
					this.setWorkingMessage(formatLoadingProgress(loadProgress));
					return;
				}

				// Download progress: per-URL done/total map.
				const downloadSum = sumDownloadProgress(data.progress);
				if (downloadSum && downloadSum.total > 0) {
					this.setWorkingMessage(formatDownloadProgress(downloadSum.done, downloadSum.total));
					return;
				}
			}

			switch (status) {
				case "loading":
					this.setWorkingMessage(`⏳ Loading ${modelId}...`);
					break;
				case "loaded":
					this.scheduleClear();
					break;
				case "unloaded":
					if (!this.watchingModel) break; // not actively watching — ignore.
					clearTimeout(this.clearTimerId);
					this.clearTimerId = setTimeout(() => {
						if (this.watchingModel === modelId) this.stopWatching();
					}, GRACE_PERIOD_MS);
					break;
			}
		}

		// download_progress events carry per-URL done/total directly in data.
		if (event.event === "download_finished" && data) {
			const sum = sumDownloadProgress(data);
			this.setWorkingMessage(
				sum ? formatDownloadProgress(sum.done, sum.total) : `✅ ${modelId} ready`,
			);
			return;
		}

		if (event.event === "download_progress" && data) {
			const sum = sumDownloadProgress(data);
			if (sum && sum.total > 0) {
				this.setWorkingMessage(formatDownloadProgress(sum.done, sum.total));
			}
		}
	}

	/** Start watching a specific model for loading state. SSE is already connected; we just set the target. */
	watch(modelId: string): void {
		if (!this.hasUIRef) return;

		this.watchingModel = modelId;
		clearTimeout(this.clearTimerId);

		// Do an immediate poll to check current state (in case loading already started).
		if (this.client && modelId) {
			void this.doSinglePoll(modelId).catch(() => {});
		}

		this.timeoutId = setTimeout(() => {
			if (this.watchingModel === modelId) this.stopWatching();
		}, TIMEOUT_MS);
	}

	private async doSinglePoll(modelId: string): Promise<void> {
		try {
			const models = await this.client!.list({ signal: AbortSignal.timeout(5000) });
			const entry = models.find((m) => m.id === modelId);
			if (!entry) return;

			// Check for download progress in status.progress.
			if (entry.status.progress != null) {
				const sum = sumDownloadProgress(entry.status.progress);
				if (sum && sum.total > 0) {
					this.setWorkingMessage(formatDownloadProgress(sum.done, sum.total));
					return;
				}
			}

			switch (entry.status.value) {
				case "loading":
					this.setWorkingMessage(`⏳ Loading ${modelId}...`);
					break;
				case "loaded":
					this.scheduleClear();
					break;
			}
		} catch {
			// Ignore poll errors — SSE is the primary mechanism.
		}
	}

	private scheduleClear(): void {
		clearTimeout(this.clearTimerId);
		this.clearTimerId = setTimeout(() => this.stopWatching(), 2000);
	}

	stopWatching(): void {
		if (this.watchingModel) {
			this.watchingModel = "";
		}
		clearTimeout(this.clearTimerId);
		this.setWorkingMessage(); // clear working message
	}

	private startPollFallback(serverUrl: string, apiKey?: string): void {
		if (this.pollTimerId) return; // already polling.

		const client = new LlamaClient(serverUrl, apiKey);
		const modelId = this.watchingModel;
		const startTime = Date.now();

		const poll = async () => {
			if (!modelId) return;
			try {
				const models = await client.list({ signal: AbortSignal.timeout(5000) });
				const entry = models.find((m) => m.id === modelId);
				if (!entry) return;

				// Check for download progress in status.progress.
				if (entry.status.progress != null) {
					const sum = sumDownloadProgress(entry.status.progress);
					if (sum && sum.total > 0) {
						this.setWorkingMessage(formatDownloadProgress(sum.done, sum.total));
						return;
					}
				}

				switch (entry.status.value) {
					case "loading":
						this.setWorkingMessage(`⏳ Loading ${modelId}...`);
						break;
					case "loaded":
						this.scheduleClear();
						return;
					case "unloaded":
						if (Date.now() - startTime > GRACE_PERIOD_MS) {
							this.stopWatching();
						}
						break;
				}

				if (Date.now() - startTime > TIMEOUT_MS) {
					this.stopWatching();
					return;
				}
			} catch {
				this.stopWatching();
			}
		};

		void poll(); // immediate first check
		this.pollTimerId = setInterval(poll, POLL_INTERVAL_MS);
	}

	private setWorkingMessage(message?: string): void {
		if (!this.uiRef || !this.hasUIRef) return;
		try {
			this.uiRef.setWorkingMessage(message);
		} catch {
			// UI may not be available in all contexts
		}
	}

	stop(): void {
		clearTimeout(this.clearTimerId);
		if (this.pollTimerId) clearInterval(this.pollTimerId);
		if (this.timeoutId) clearTimeout(this.timeoutId);
		this.sseAbortController?.abort();
		this.watchingModel = "";
		this.pollTimerId = null;
		this.timeoutId = null;
		this.clearTimerId = null;
		this.sseAbortController = null;
		this.client = null;
	}
}

function formatLoadingProgress(p: { name: string; stageIndex: number; totalStages: number; stageRatio?: number }): string {
	const ratio = p.stageRatio ?? 0;
	// Overall progress: completed stages + current stage fraction.
	const overall = (p.stageIndex + ratio) / Math.max(p.totalStages, 1);
	return `⏳ Loading ${p.name} (stage ${p.stageIndex + 1}/${p.totalStages}) ${progressBar(ratio)} ${(ratio * 100).toFixed(0).padStart(3)}% (${(overall * 100).toFixed(0)}% total)`;
}

function formatDownloadProgress(done: number, total: number): string {
	const ratio = done / total;
	return `⏳ Downloading ${progressBar(ratio)} ${(ratio * 100).toFixed(0).padStart(3)}% · ${formatBytes(done)} / ${formatBytes(total)}`;
}
