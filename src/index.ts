import { type ExtensionAPI, type ExtensionContext, readStoredCredential } from "@earendil-works/pi-coding-agent";
import { InferenceStatusManager } from "./inference-status";
import { createLlamaProvider, LLAMA_PROVIDER_ID } from "./provider";

/** Normalize a server URL: strip trailing slashes and /v1. */
function normalizeBaseUrl(url: string): string {
	try {
		const u = new URL(url.trim());
		u.pathname = u.pathname.replace(/\/+$/, "").replace(/\/v1$/, "") || "/";
		return u.toString().replace(/\/$/, "");
	} catch {
		return url;
	}
}

/** Resolve server URL from stored credential or env vars (no modelRegistry needed). */
function resolveServerUrl(): string | undefined {
	const cred = readStoredCredential(LLAMA_PROVIDER_ID);
	if (cred && cred.type === "api_key") {
		const envVal = cred.env?.LLAMA_BASE_URL;
		if (typeof envVal === "string" && envVal.trim()) return normalizeBaseUrl(envVal);
	}
	const raw = process.env.LLAMA_BASE_URL?.trim();
	if (!raw) return undefined;
	try {
		return normalizeBaseUrl(raw);
	} catch {
		return undefined;
	}
}

/** Resolve API key from stored credential or env vars (no modelRegistry needed). */
function resolveApiKey(): string | undefined {
	const cred = readStoredCredential(LLAMA_PROVIDER_ID);
	if (cred && cred.type === "api_key") {
		const key = cred.key;
		if (typeof key === "string" && key.trim()) return key;
	}
	return process.env.LLAMA_API_KEY || undefined;
}

export default async function (pi: ExtensionAPI) {
	const controller = createLlamaProvider();

	// Register the dynamic provider with Pi
	pi.registerProvider(controller.provider);

	/** Refresh catalog from the live server and update Pi's model registry. */
	async function refreshCatalog(ctx: ExtensionContext): Promise<void> {
		try {
			const authStatus = ctx.modelRegistry.getProviderAuthStatus(LLAMA_PROVIDER_ID);
			if (!authStatus.configured) return;

			const authResult = await ctx.modelRegistry.getProviderAuth(LLAMA_PROVIDER_ID);
			if (!authResult) return;

			const envUrl = authResult.env?.LLAMA_BASE_URL;
			const serverUrl = typeof envUrl === "string" && envUrl.trim() ? normalizeBaseUrl(envUrl) : undefined;
			if (!serverUrl) return;

			inferenceStatus.updateServerUrl(serverUrl);
			inferenceStatus.connect(serverUrl, authResult.auth.apiKey);

			const { LlamaClient } = await import("./client");
			const client = new LlamaClient(serverUrl, authResult.auth.apiKey);
			const catalog = await client.list();
			controller.setCatalog(catalog, serverUrl);
		} catch {
			// Catalog refresh failed — models stay at last known state.
		}
	}

	/** Thinking budget injection for before_provider_request events. */
	async function injectThinkingBudget(event: { payload: unknown }, ctx: ExtensionContext): Promise<void> {
		const payload = event.payload as Record<string, unknown> | undefined;
		if (!payload || typeof payload.model !== "string") return;

		const authResult = await ctx.modelRegistry.getProviderAuth(LLAMA_PROVIDER_ID);
		if (!authResult) return;

		const envUrl = authResult.env?.LLAMA_BASE_URL;
		const serverUrl = typeof envUrl === "string" ? normalizeBaseUrl(envUrl) : "";
		const inferenceUrl = `${serverUrl}/v1`;

		const models = controller.provider.getModels();
		const targetModel = models.find((m) => m.id === payload.model);
		if (!targetModel || (targetModel.baseUrl !== inferenceUrl && serverUrl !== "")) return;

		const { ThinkingBudgetResolver } = await import("./resolver");
		const resolver = new ThinkingBudgetResolver();
		const level = resolver.resolveThinkingLevel() ?? "medium";
		const budgets = resolver.resolveThinkingBudgets();
		const thinkingBudgetTokens = budgets[level];

		payload.return_progress = true;
		payload.timings_per_token = true;

		if (level === "off") {
			payload.chat_template_kwargs = { enable_thinking: false };
		} else if (level !== "max" && thinkingBudgetTokens != null) {
			payload.thinking_budget_tokens = thinkingBudgetTokens;
		}
	}

	// ─── Eager catalog refresh at registration time ──────────────
	// Pi resolves models before session_start fires. We need our catalog populated
	// by then or it shows "No API key found" / "No models available". Read stored
	// credential directly from auth.json since modelRegistry isn't ready yet (pre-bindCore).

	const serverUrl = resolveServerUrl();
	if (serverUrl) {
		try {
			const apiKey = resolveApiKey();
			const { LlamaClient } = await import("./client");
			const client = new LlamaClient(serverUrl, apiKey);
			// Use a short timeout so we don't block startup when server is unreachable.
			const ac = new AbortController();
			setTimeout(() => ac.abort(), 2000);
			try {
				const catalog = await client.list({ signal: ac.signal });
				controller.setCatalog(catalog, serverUrl);
			} catch {
				// Server not reachable — will retry on session_start.
			}
		} catch {
			// Import or other error — will retry on session_start.
		}
	}

	let inferenceStatus: InferenceStatusManager;
	try {
		inferenceStatus = new InferenceStatusManager();
		inferenceStatus.install(serverUrl);
		if (serverUrl) {
			inferenceStatus.connect(serverUrl, resolveApiKey());
		}
	} catch {
		inferenceStatus = null as any;
	}

	// ─── Event handlers ──────────────

	pi.on("before_provider_request", async (event, ctx) => {
		const payloadModel = (event.payload as Record<string, unknown> | undefined)?.model as string | undefined;

		// Update UI context, reset state, and start queue detection.
		inferenceStatus?.onBeforeProviderRequest(ctx, payloadModel);
		void inferenceStatus?.checkQueue(payloadModel);

		await injectThinkingBudget(event, ctx);
	});

	pi.on("model_select", async (event, ctx) => {
		// Only refresh catalog for our own models.
		if (event.model?.provider !== LLAMA_PROVIDER_ID) return;

		await refreshCatalog(ctx);
	});

	pi.on("session_start", (event, ctx) => {
		if (event.reason !== "startup") return;
		void refreshCatalog(ctx);
	});

	pi.on("turn_start", (_event, ctx) => {
		inferenceStatus?.onTurnStart(ctx);
	});

	pi.on("before_agent_start", (_event, ctx) => {
		inferenceStatus?.onTurnStart(ctx);
	});

	pi.on("turn_end", (_event, _ctx) => {
		inferenceStatus?.onTurnEnd(_ctx);
	});

	pi.on("session_shutdown", async () => {
		inferenceStatus?.uninstall();
	});
}
