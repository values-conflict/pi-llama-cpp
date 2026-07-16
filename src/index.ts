import {
  type BeforeProviderRequestEvent,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type SessionBeforeSwitchEvent,
  type SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { PROVIDER_NAME } from "./constants";
import { ModelSelectEvent } from "./interfaces/events";
import { CommandManager } from "./managers/command";
import { EventManager } from "./managers/events";
import { ServerManager } from "./managers/server";
import { InferenceStatusManager } from "./inference-status";
import { ConfigResolver } from "./resolver";
import { Server } from "./server";

export default async function (pi: ExtensionAPI) {
  const resolver = new ConfigResolver();
  const urls = await resolver.resolveUrls();
  const servers = urls.map((url) => new Server(url));

  const eventManager = new EventManager(servers);
  const serverManager = new ServerManager(servers);
  const commandManager = new CommandManager(serverManager);
  const inferenceStatus = new InferenceStatusManager(servers);

  // Install fetch interceptor for inference status tracking
  inferenceStatus.install();

  // Register providers once at startup
  await serverManager.initialize(pi);

  // Single global /models command
  pi.registerCommand("models", {
    description: `Browse ${PROVIDER_NAME} models`,
    getArgumentCompletions: commandManager.getArgumentCompletions,
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      await commandManager.handleCommand(args, ctx, pi);
    },
  });

  // Events
  pi.on("session_start", (event: SessionStartEvent, ctx: ExtensionContext) => {
    if (event.reason !== "startup") return;
    for (const warning of serverManager.getWarnings())
      ctx.ui.notify(warning, "warning");

    for (const warning of resolver.getWarnings())
      ctx.ui.notify(warning, "warning");
  });

  pi.on("before_agent_start", (_event: unknown, ctx: ExtensionContext) => {
    inferenceStatus.onBeforeAgentStart(ctx);
  });

  pi.on("turn_start", (_event: unknown, ctx: ExtensionContext) => {
    inferenceStatus.onTurnStart(ctx);
  });

  pi.on(
    "before_provider_request",
    async (event: BeforeProviderRequestEvent) =>
      await eventManager.onBeforeProviderRequest(event),
  );

  pi.on(
    "model_select",
    async (event: ModelSelectEvent, ctx: ExtensionContext) =>
      await eventManager.onModelSelect(event, ctx),
  );
  pi.on(
    "session_before_switch",
    async (_: SessionBeforeSwitchEvent, ctx: ExtensionContext) =>
      await eventManager.onSessionBeforeSwitch(ctx),
  );

  pi.on("turn_end", (_event: unknown, ctx: ExtensionContext) => {
    inferenceStatus.onTurnEnd(ctx);
  });

  pi.on("session_shutdown", async () => {
    inferenceStatus.uninstall();
  });
}
