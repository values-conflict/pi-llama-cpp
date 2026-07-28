import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";

/** Default thinking budgets mapped to Pi's thinking levels. */
export const DEFAULT_THINKING_BUDGETS: Record<string, number> = {
	off: 0,
	minimal: 1024,
	low: 2048,
	medium: 8192,
	high: 16384,
	xhigh: 32768,
	max: -1,
};

/** Resolves thinking budget configuration from Pi settings. */
export class ThinkingBudgetResolver {
	private readonly settingsManager = SettingsManager.create(process.cwd(), getAgentDir());

	/** Returns the current default thinking level from Pi. */
	resolveThinkingLevel(): ModelThinkingLevel | undefined {
		return this.settingsManager.getDefaultThinkingLevel();
	}

	/** Returns effective thinking budgets (defaults + user overrides). */
	resolveThinkingBudgets(): Record<string, number> {
		const settingsBudgets = this.settingsManager.getThinkingBudgets() ?? {};
		return { ...DEFAULT_THINKING_BUDGETS, ...settingsBudgets };
	}
}
