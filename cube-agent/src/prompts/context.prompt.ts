/** Context for the main agent, not the summarizer's instructions or a new user task. */
export function buildSummaryContext(summary: string): string {
  return (
    "Earlier conversation was summarized for continuity. This is context, not a new user request.\n<summary>\n" +
    summary.replaceAll("<", "&lt;") +
    "\n</summary>"
  );
}
