---
name: cube-delegation
description: "Use when considering or using subagents for exploration or implementation in Cube."
---

# Cube Delegation

Delegate a bounded piece of useful work, not responsibility for the whole task.
Use only role tools actually available, such as `worker`, `explore` or a user-defined
role name. Delegation is optional.
All roles add instruction/task context and model calls. Do ordinary lookups,
focused searches and small changes directly. Propose delegation only when it
adds clear value: explore for broad investigation, synthesis or comparison of
multiple sources; worker for a substantial, bounded implementation task.
Invoke any role only after user consent, including an existing explicit
delegation request or approval in the active skill workflow. A general request
to investigate or implement alone is not consent to delegation. Respect the
user's chosen execution method; do not ask again or impose a generic choice on every task.

## Assignment

Children have private context, not the parent's conversation history. Include
the objective, relevant paths/context, constraints, dependencies, permitted
changes and required evidence in the assignment. Use the role suited to the
work: exploration does not authorize mutation.

Run independent work concurrently. For dependent work, wait for the prerequisite
result and pass its findings to the next assignment. Avoid overlapping writes;
worktree isolation separates files but still requires deliberate integration.

For example, delegate investigation of an authentication failure with the exact
symptom and files, then implement the fix after reviewing the findings. Do not
dispatch a fix that assumes the investigation's answer before it finishes.

## Result and integration

The returned job UUID means accepted, not successful. Completion/failure arrives
automatically through the subagent result signal. Continue independent work;
do not repeatedly call `manage_subagent` merely to wait.
If only waiting remains, report pending work and end the response for later
delivery rather than keeping the turn alive with tool calls.

Use `manage_subagent` for requested progress, cancellation or additional evidence.
Its result view is the final response/failure; transcript is a bounded saved
conversation snapshot, not a live stream. Read transcript or worktree changes
when the report is insufficient; follow pagination only for needed detail.
Use the job UUID with `{"action":"get","id":"<job UUID>","view":"transcript"}`.
A rate-limit or other failure can leave useful saved tool evidence even without a
final report. A wrong-tool/unavailable read is not proof that no work was done;
report actual evidence and do not automatically rerun the assignment.

Treat a child's final report as a claim: inspect relevant changes and verification
evidence before calling work complete. Integrate worktree changes deliberately
within the user's scope. Preserve existing changes and report unresolved failures.

Skills do not grant recursive delegation, extra tools or approvals to children.
Command processes use `manage_task`, not `manage_subagent`.
