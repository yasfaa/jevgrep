import type { DiagnosticResult } from "@repo/core";

function quote(value: string): string {
  return JSON.stringify(value).replace(
    /[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

export function renderDiagnostic(result: DiagnosticResult): string {
  const { trace, rankedRootCauses, suspects, status } = result;

  const lines: string[] = [
    `Jev Diagnostic: ${rankedRootCauses.length} likely root cause(s) identified from trace.`,
  ];

  if (trace.errorName || trace.errorMessage) {
    lines.push(`Error: ${trace.errorName ?? "Unknown"}: ${trace.errorMessage ?? "No description"}`);
  }

  if (status === "no_candidates") {
    lines.push(
      "No matching repository declarations found in the provided stack trace. Check file paths and root.",
    );
    return lines.join("\n") + "\n\nEnd context.\n";
  }

  lines.push("", "Ranked Suspects (Calibrated Root-Cause Probability):");

  for (const item of suspects) {
    const rootPct = Math.round(item.rootCauseProbability * 100);
    const propPct = Math.round(item.secondaryPropagationProbability * 100);
    const tag =
      item.verdict === "root_cause"
        ? "[PRIMARY ROOT CAUSE]"
        : item.verdict === "propagated_symptom"
          ? "[PROPAGATED SYMPTOM]"
          : "[UNLIKELY]";

    lines.push(
      `- ${tag} ${quote(item.candidate.path)} @ ${item.candidate.name} (lines ${item.candidate.range.startLine}-${item.candidate.range.endLine})`,
      `  Root Cause: ${rootPct}% | Secondary Propagation: ${propPct}% | Confidence: ${(item.confidence * 100).toFixed(0)}%`,
    );
  }

  if (rankedRootCauses.length > 0) {
    lines.push("", "Primary Suspect Code Blocks:");
    for (const item of rankedRootCauses.slice(0, 3)) {
      lines.push(
        "",
        `Suspect block ${quote(item.candidate.path)} lines ${item.candidate.range.startLine}-${item.candidate.range.endLine} (${Math.round(item.rootCauseProbability * 100)}% root-cause probability):`,
        "```",
        item.candidate.source,
        "```",
      );
    }
  }

  return lines.join("\n") + "\n\nEnd context.\n";
}
