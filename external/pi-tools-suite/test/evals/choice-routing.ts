import { CHOICE_ACTIONS_CAPABILITY, lastChoiceActions } from "../../../../src/bundled-extensions/choice-actions/contract.js";
import { normalizeQuestionInput } from "../../src/question/contract.js";
import type { QuestionToolInput } from "../../src/question/types.js";
import type { EvalCase, EvalRunResult } from "./harness/types.js";

export type ChoiceRoute = "question" | "checklist" | "reply";

/** No UI/answer simulation: validate the complete selected batch at the question boundary. */
export function validateChoiceRoute(result: EvalRunResult, route: ChoiceRoute, minDescriptions = 0): string[] {
	const errors: string[] = [];
	const calls = result.events.filter((event) => event.type === "tool_call");
	const checkpoints = result.events.filter((event) => event.type === "selection_checkpoint");
	const output = [...checkpoints.map((event) => event.text ?? ""), result.stdout].join("\n");
	const actions = lastChoiceActions(output);
	if (checkpoints.some((event) => event.stopReason !== "toolUse")) errors.push("incomplete tool-selection response");
	if (/"(?:actions|risk|label|prompt)"\s*:/.test(output)) errors.push("JSON action menu instead of native interaction");
	if (route === "question") {
		if (calls.length !== 1 || calls[0]?.toolName !== "question") errors.push("expected exactly one question call and no other tools");
		else {
			try {
				const questions = normalizeQuestionInput(calls[0].input as QuestionToolInput);
				const descriptions = questions.flatMap((question) => question.choices).filter((choice) => choice.description?.trim());
				if (descriptions.length < minDescriptions) errors.push("missing per-choice descriptions");
				if (/"risk"\s*:/.test(JSON.stringify(calls[0].input))) errors.push("risk belongs in choice.description, not a risk field");
			}
			catch { errors.push("invalid question arguments"); }
		}
		if (/pix-actions/.test(output)) errors.push("question must not be replaced or duplicated by actions");
	} else {
		if (calls.length) errors.push("completed checkpoint must not call tools");
		if (!actions || Boolean(actions.buttons) !== (route === "reply")) errors.push(`expected valid ${route}`);
		const fences = [...output.matchAll(/^\s{0,3}(`{3,}|~{3,})([^\n]*)$/gm)];
		const open = fences[fences.length - 2];
		const close = fences[fences.length - 1];
		if (!open?.[2]?.startsWith("pix-actions") || !close || close[2]?.trim()
			|| output.slice(close.index! + close[0].length).trim()) errors.push("actions must end the response");
	}
	return errors;
}

const scenarios: Array<{ id: string; route: ChoiceRoute; prompt: string; minDescriptions?: number }> = [
	{
		id: "mixed-risk-report", route: "question", minDescriptions: 2,
		prompt: "Контекст: переход на новые стены завершён, проверки пройдены, коммита нет. Возможные продолжения: проверить висящую в тумане дверь на кадре m-after-move2 (сид 270922); удалить tools/art/wall_surfaces.py и tools/art/refine_wall_materials.py с обновлением ссылок; удалить архив wiki/presentation/art/output/final/walls; закоммитить переход. Мне нужно выбрать дальнейшее направление. Дай краткий итог и получи мой выбор, пояснив у вариантов последствия и риски (например, удаление скриптов лишит нас старого генератора, а удаление архива — старых изображений). До ответа не продолжай.",
	},
	{
		id: "risk-descriptions", route: "question", minDescriptions: 2,
		prompt: "Перед реализацией мне нужно выбрать SQLite или JSON. Получи мой выбор и кратко поясни риск у каждого варианта: для SQLite — сложность миграций, для JSON — потеря данных при параллельной записи. Не выбирай за меня и не начинай реализацию.",
	},
	{
		id: "tradeoff-descriptions", route: "question", minDescriptions: 2,
		prompt: "Перед подготовкой документа мне нужно выбрать формат: краткая памятка или подробное руководство. Получи мой выбор. У каждого варианта поясни компромисс: памятка быстрее читается, но без деталей; руководство подробнее, но требует больше времени. Рисковых операций здесь нет. Пока не пиши документ.",
	},
	{
		id: "exclusive-direction", route: "question",
		prompt: "Перед реализацией нужно выбрать ровно один вариант хранения: SQLite или JSON. Оба подходят технически, но мои предпочтения неизвестны. Получи мой выбор, не выбирай за меня и пока ничего не реализуй.",
	},
	{
		id: "optional-followups", route: "checklist",
		prompt: "Задача полностью завершена, ничего не заблокировано, решения и подтверждения не нужны. Дай краткий итог и предложи на будущее два независимых необязательных продолжения: объяснить готовую архитектуру и составить глоссарий. Сейчас их не выполняй.",
	},
	{
		id: "optional-commit", route: "checklist",
		prompt: "Работа полностью завершена, тесты пройдены, для текущей задачи больше ничего решать не нужно. Дай краткий итог и предложи коммит готовых изменений как необязательное продолжение на будущее. Сейчас коммит не выполняй.",
	},
	{
		id: "manual-step", route: "reply",
		prompt: "Всё настроено и проверено. Остался только мой ручной шаг: перезапустить локальное приложение. Никаких решений или разрешений не требуется. Напомни мне об этом и дай короткий способ сообщить, что я закончил. Не выполняй дальнейшую работу.",
	},
];

export const CHOICE_ROUTING_CASES: EvalCase[] = scenarios.map(({ id, route, prompt, minDescriptions }) => ({
	id: `choice.${id}`, category: "tool-selection", description: `Route ${id} to ${route}`,
	fixture: "demo", prompt,
	appendSystemPrompt: CHOICE_ACTIONS_CAPABILITY,
	// Clean Pi registers the same question schema/guidelines; no Desktop UI is exercised.
	env: { PIX_CONFIG_PROFILE: "", PIX_ACP_SESSION_STATE_BRIDGE: "", PIX_QUESTION_RPC_BRIDGE: "" },
	stopAtTools: ["question"],
	assert: { maxToolCalls: route === "question" ? 1 : 0, maxFilesChanged: 0 },
	validate: (result) => validateChoiceRoute(result, route, minDescriptions),
}));
