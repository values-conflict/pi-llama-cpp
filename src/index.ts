import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { InferenceStatusManager } from "./inference-status";
import { LLAMA_PROVIDER_ID, createLlamaProvider } from "./provider";
import { ModelLoadingWatcher } from "./model-loading";

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
  if (cred && typeof cred === "object") {
    const envVal = (cred as any).env?.LLAMA_BASE_URL;
    if (typeof envVal === "string" && envVal.trim()) return normalizeBaseUrl(envVal);
  }
  const raw = process.env.LLAMA_BASE_URL?.trim();
  if (!raw) return undefined;
  try { return normalizeBaseUrl(raw); } catch { return undefined; }
}

/** Resolve API key from stored credential or env vars (no modelRegistry needed). */
function resolveApiKey(): string | undefined {
  const cred = readStoredCredential(LLAMA_PROVIDER_ID);
  if (cred && typeof cred === "object") {
    const key = (cred as any).key;
    if (typeof key === "string" && key.trim()) return key;
  }
  return process.env.LLAMA_API_KEY || undefined;
}

export default async function (pi: ExtensionAPI) {
  const controller = createLlamaProvider();

  // Register the dynamic provider with Pi
  pi.registerProvider(controller.provider);

  /** Resolve server URL from auth credentials via modelRegistry. */
  async function resolveServerUrlFromAuth(): Promise<string | undefined> {
    if (!pi.modelRegistry) return undefined;
    const result = await pi.modelRegistry.getProviderAuth(LLAMA_PROVIDER_ID);
    if (!result) return undefined;

    const envUrl = result.env?.LLAMA_BASE_URL as string | undefined;
    if (typeof envUrl === "string" && envUrl.trim()) {
      return normalizeBaseUrl(envUrl);
    }
    const baseUrl = result.auth?.baseUrl as string | undefined;
    if (typeof baseUrl === "string") {
      return normalizeBaseUrl(baseUrl.replace(/\/v1$/, ""));
    }
    return undefined;
  }

  /** Refresh catalog from the live server and update Pi's model registry. */
  async function refreshCatalog(): Promise<void> {
    if (!pi.modelRegistry) return;
    try {
      const result = await pi.modelRegistry.getProviderAuth(LLAMA_PROVIDER_ID);
      if (!result) return;

      const envUrl = result.env?.LLAMA_BASE_URL as string | undefined;
      const serverUrl = typeof envUrl === "string" && envUrl.trim() ? normalizeBaseUrl(envUrl) : undefined;
      if (!serverUrl) return;

      inferenceStatus.updateServerUrl(serverUrl);

      // Reconnect SSE if server URL changed.
      modelLoadingWatcher.connect(
        serverUrl,
        result.auth?.apiKey as string | undefined,
      );

      const { LlamaClient } = await import("./client");
      const client = new LlamaClient(
        serverUrl,
        result.auth?.apiKey as string | undefined,
      );
      const catalog = await client.list();
      controller.setCatalog(catalog, serverUrl);
    } catch {
      // Catalog refresh failed — models stay at last known state.
    }
  }

  /** Thinking budget injection for before_provider_request events. */
  async function injectThinkingBudget(event: any): Promise<void> {
    const payload = event.payload as { model?: string };
    if (!payload?.model) return;

    if (!pi.modelRegistry) return;
    const authResult = await pi.modelRegistry.getProviderAuth(LLAMA_PROVIDER_ID);
    if (!authResult) return;

    const envUrl = authResult.env?.LLAMA_BASE_URL as string | undefined;
    const serverUrl = typeof envUrl === "string" ? normalizeBaseUrl(envUrl) : "";
    const inferenceUrl = `${serverUrl}/v1`;

    const models = controller.provider.getModels();
    const targetModel = models.find((m: any) => m.id === payload.model);
    if (!targetModel || (targetModel as any).baseUrl !== inferenceUrl && serverUrl !== "") return;

    const { ThinkingBudgetResolver } = await import("./resolver");
    const resolver = new ThinkingBudgetResolver();
    const level = resolver.resolveThinkingLevel() ?? "medium";
    const budgets = resolver.resolveThinkingBudgets();
    const thinking_budget_tokens = budgets[level];

    payload.return_progress = true as any;
    payload.timings_per_token = true as any;

    if (level === "off") {
      payload.chat_template_kwargs = { enable_thinking: false };
    } else if (level !== "max" && thinking_budget_tokens != null) {
      payload.thinking_budget_tokens = thinking_budget_tokens;
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
      } catch (err) {
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
  } catch {
    inferenceStatus = null as any;
  }

  const modelLoadingWatcher = new ModelLoadingWatcher();

  // Connect SSE immediately so we catch all loading events in real-time.
  if (serverUrl) {
    try {
      modelLoadingWatcher.connect(serverUrl, resolveApiKey());
    } catch (e) {
      console.log(`[llama-cpp] initial SSE connect failed: ${e}`);
    }
  }

  // ─── Event handlers ──────────────

  pi.on(
    "before_provider_request",
    async (event: { payload?: { model?: string } }, ctx: { ui?: any; hasUI?: boolean }) => {
      const payloadModel = event.payload?.model;

      // Update UI context and start watching the target model.
      if (payloadModel && ctx.ui) {
        modelLoadingWatcher.setUiContext(ctx.ui, !!ctx.hasUI);
        modelLoadingWatcher.watch(payloadModel);
      }

      await injectThinkingBudget(event);
    },
  );

  pi.on(
    "model_select",
    async (
      event: { model?: { id?: string; provider?: string }; previousModel?: any },
      _ctx: unknown,
    ) => {
      // Only refresh catalog for our own models.
      if (event.model?.provider !== LLAMA_PROVIDER_ID) return;

      await refreshCatalog();
    },
  );

  pi.on("session_start", (event: any, _ctx: any) => {
    if (event.reason !== "startup") return;
    void refreshCatalog();
  });

  pi.on(
    "turn_start",
    (_event: unknown, ctx: { ui?: any; hasUI?: boolean }) => {
      // Stop loading watch when a turn starts — if we reach here,
      // the request went through so loading is done.
      modelLoadingWatcher.stopWatching();

      inferenceStatus?.onTurnStart(ctx);
    },
  );

  pi.on("before_agent_start", (_event: unknown, ctx: any) => {
    inferenceStatus?.onBeforeAgentStart(ctx);
  });

  pi.on("turn_end", (_event: unknown, _ctx: any) => {
    inferenceStatus?.onTurnEnd(_ctx as any);
  });

  pi.on("session_shutdown", async () => {
    modelLoadingWatcher.disconnect();
    inferenceStatus?.uninstall();
  });
}
