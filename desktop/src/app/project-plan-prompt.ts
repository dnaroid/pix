/** Execution rules stay available when the authoring guide is not loaded. */
export function buildProjectPlanPrompt(path: string): string {
  return [
    `Execute the project plan stored at ${JSON.stringify(path)}.`,
    "Read the saved file first and verify it against the current code and project instructions. Implement the changes and run the relevant checks. If the saved file is missing, stop and ask for its location.",
    "Resolve technical questions from available code, specifications and permitted checks first. Pause work affected by unresolved BLOCKER items or material ambiguity, including its dependents. Ask when resolution needs the user's intent, authorization or information you cannot obtain; reuse applicable decisions and authorization already given. Continue only work whose independence is established from the plan and current code.",
    "Honor each gate before its named phase, step or action. Required evidence must be obtainable before crossing the gate. Missing, failed or unrun required checks mean No-Go; record the evidence and follow the specified No-Go action. Never weaken a gate to proceed or treat Go as user authorization. An exception requires explicit user acceptance of the risk, must respect project constraints and must preserve the actual check results.",
    "For parallel groups, establish shared contracts and dependencies, assign exclusive write ownership including shared mutable resources, and give each subagent context, scope, done conditions and required checks. Delegate within project/tool policy only when the benefit outweighs coordination and integration costs. Keep one integrator responsible for reconciling outputs, updating the plan and checking the combined result.",
    "Mark steps complete only with observed verification evidence; a subagent completion status alone is insufficient. Retain concrete check results and confirm their applicability after integration. Reuse applicable evidence without implying it was rerun. Record unrun checks as \"not run: reason\".",
    "If later work invalidates earlier completion or verification, reopen the affected checklist items and mark affected gates No-Go until resolved under the gate rules. Preserve historical evidence and evidence that remains applicable, including in flat checklists.",
    "Re-read the plan before writing status so you do not overwrite concurrent edits; reconcile material changes instead of replacing them. Material replanning follows the project's authoring-guide rules. Report the result and any remaining work.",
  ].join("\n");
}
