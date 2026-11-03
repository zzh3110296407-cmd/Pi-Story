import { settingsTemplate } from "../../prepare-p2.mjs";

export const MODEL_SETTINGS = {
	"flash-low": { model: "deepseek/deepseek-flash", thinking: "low" },
	"pro-low": { model: "deepseek/deepseek-v4-pro", thinking: "low" },
	"flash-off": { model: "deepseek/deepseek-flash", thinking: "off" },
} as const;
export type ModelSetting = keyof typeof MODEL_SETTINGS;
export function evaluationSettings(work: string, suite: string, comparison?: ModelSetting) {
	const settings = settingsTemplate(work);
	let showrunner: { model: string; thinking: "low" | "off" } = MODEL_SETTINGS["flash-low"];
	if (comparison) {
		const chosen = MODEL_SETTINGS[comparison];
		if (suite === "P2-OPEN") showrunner = chosen;
		else if ((suite === "P2-EDIT" || suite === "P2-KEEP") && comparison !== "flash-off")
			settings.roles[suite === "P2-EDIT" ? "editor" : "keeper"].model = chosen.model;
		else throw new Error("This comparison is not allowed for this suite");
	}
	return { settings, showrunner };
}
