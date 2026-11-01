import { describe, expect, test } from "bun:test";
import { CHOICE_ROUTING_CASES, validateChoiceRoute, type ChoiceRoute } from "./choice-routing.js";
import { deriveMetrics } from "./harness/metrics.js";
import type { EvalEvent, EvalRunResult } from "./harness/types.js";
import { QUESTION_TOOL_DESCRIPTION as hostQuestion } from "../../../../src/bundled-extensions/question/tool-description.js";
import { QUESTION_TOOL_DESCRIPTION as suiteQuestion } from "../../src/question/tool-description.js";
import { CHOICE_ACTIONS_CAPABILITY } from "../../../../src/bundled-extensions/choice-actions/contract.js";
import { EVAL_CASES } from "./cases.js";

const input = { questions: [{ id: "storage", label: "Storage", prompt: "SQLite or JSON?", choices: [
    { value: "sqlite", label: "SQLite", description: "Migration complexity" },
    { value: "json", label: "JSON", description: "Concurrent write data loss" },
] }] };
function result(route: ChoiceRoute): EvalRunResult {
    const events: EvalEvent[] = route === "question" ? [{ type: "tool_call", toolName: "question", input: structuredClone(input) }] : [];
    return {
        caseId: "fixture", model: "fixture", projectDir: "/missing", stderr: "", exitCode: 0, timedOut: false,
        stdout: {
            question: "Choose the storage format.",
            reply: "Restart the app.\n```pix-actions\n- Done\n```",
            checklist: "Done.\n```pix-actions Continue\n- [x] Explain architecture\n- [ ] Write glossary\n```",
        }[route],
        events, metrics: deriveMetrics({ events, elapsedMs: 1, changedFiles: [], projectDir: "/missing", sessionDir: "/missing" }), assertions: [], passed: false,
    };
}

describe("choice routing eval controls", () => {
    test("uses current shared guidance and registers all seven cases", () => {
        expect(hostQuestion).toEqual(suiteQuestion);
        expect(CHOICE_ROUTING_CASES).toHaveLength(7);
        for (const scenario of CHOICE_ROUTING_CASES) {
            expect(scenario.appendSystemPrompt).toBe(CHOICE_ACTIONS_CAPABILITY);
            expect(scenario.stopAtTools).toEqual(["question"]);
            expect(scenario.blockTools).toBeUndefined();
            expect(EVAL_CASES).toContain(scenario);
        }
    });
    for (const route of ["question", "checklist", "reply"] as const) {
        test(`${route}: accepts the expected interaction`, () => expect(validateChoiceRoute(result(route), route)).toEqual([]));
        test(`${route}: rejects narration and JSON menus`, () => {
            for (const stdout of ["Which option?", '[{"label":"Delete","prompt":"Delete files"}]', '{"version":1,"actions":[{"label":"Delete","prompt":"Delete files","risk":"destructive"}]}']) {
                const r = result(route); r.events = []; r.stdout = stdout;
                expect(validateChoiceRoute(r, route).length).toBeGreaterThan(0);
            }
        });
        test(`${route}: rejects extra work`, () => {
            const r = result(route); r.events.push({ type: "tool_call", toolName: "bash", input: { command: "git commit -am done" } });
            expect(validateChoiceRoute(r, route).length).toBeGreaterThan(0);
        });
    }
    test("rejects malformed question arguments, retries and checklist duplication", () => {
        for (const mutate of [
            (r: EvalRunResult) => { r.events[0]!.input = { questions: [{ ...input.questions[0], prompt: "" }] }; },
            (r: EvalRunResult) => { r.events[0]!.input = { questions: [{ ...input.questions[0], choices: [input.questions[0]!.choices[0]] }] }; },
            (r: EvalRunResult) => { r.events[0]!.input = { questions: [{ ...input.questions[0], choices: input.questions[0]!.choices.map(({ value, ...choice }) => choice) }] }; },
            (r: EvalRunResult) => { r.events[0]!.input = { questions: [{ ...input.questions[0], choices: input.questions[0]!.choices.map(({ label, ...choice }) => choice) }] }; },
            (r: EvalRunResult) => { r.events.push(r.events[0]!); },
            (r: EvalRunResult) => { r.stdout += result("checklist").stdout; },
        ]) {
            const r = result("question"); mutate(r);
            expect(validateChoiceRoute(r, "question").length).toBeGreaterThan(0);
        }
    });
    test("validates checkpoint text and rejects truncated or extra tool selections", () => {
        const r = result("question");
        r.stdout = "";
        r.events.unshift({ type: "selection_checkpoint", text: "Choose storage.", stopReason: "toolUse" });
        expect(validateChoiceRoute(r, "question", 2)).toEqual([]);
        r.events[0]!.text += result("checklist").stdout;
        expect(validateChoiceRoute(r, "question", 2)).toContain("question must not be replaced or duplicated by actions");
        r.events[0]!.text = "Choose storage.";
        r.events[0]!.stopReason = "length";
        expect(validateChoiceRoute(r, "question", 2)).toContain("incomplete tool-selection response");
        r.events[0]!.stopReason = "toolUse";
        r.events.push({ type: "tool_call", toolName: "unknown", input: {} });
        expect(validateChoiceRoute(r, "question", 2)).toContain("expected exactly one question call and no other tools");
    });
    test("keeps per-choice risks in descriptions, not labels, prose or risk fields", () => {
        expect(validateChoiceRoute(result("question"), "question", 2)).toEqual([]);
        for (const placement of ["missing", "label", "prose", "risk"]) {
            const r = result("question");
            r.events[0]!.input = { questions: [{ ...input.questions[0], choices: input.questions[0]!.choices.map(({ description, ...choice }) => ({
                ...choice,
                ...(placement === "label" ? { label: `${choice.label}: ${description}` } : {}),
                ...(placement === "risk" ? { description, risk: "high" } : {}),
            })) }] };
            if (placement === "prose") r.stdout = "SQLite: Migration complexity. JSON: Concurrent write data loss.";
            expect(validateChoiceRoute(r, "question", 2).length).toBeGreaterThan(0);
        }
    });
    test("description-bearing scenarios actually require choice descriptions", () => {
        for (const id of ["mixed-risk-report", "risk-descriptions", "tradeoff-descriptions"]) {
            const scenario = CHOICE_ROUTING_CASES.find((entry) => entry.id === `choice.${id}`)!;
            expect(scenario.validate!(result("question"))).toEqual([]);
            const r = result("question");
            r.events[0]!.input = { questions: [{ ...input.questions[0], choices: input.questions[0]!.choices.map(({ description, ...choice }) => choice) }] };
            expect(scenario.validate!(r)).toContain("missing per-choice descriptions");
        }
    });
    test("rejects wrong action mode and nonterminal or incomplete fences", () => {
        expect(validateChoiceRoute(result("reply"), "checklist").length).toBeGreaterThan(0);
        expect(validateChoiceRoute(result("checklist"), "reply").length).toBeGreaterThan(0);
        for (const stdout of [result("checklist").stdout + "\nMore work", "```pix-actions Continue\n- [x] Explain", result("checklist").stdout + "\n```text\nOther\n```"]) {
            const r = result("checklist"); r.stdout = stdout;
            expect(validateChoiceRoute(r, "checklist").length).toBeGreaterThan(0);
        }
    });
});
