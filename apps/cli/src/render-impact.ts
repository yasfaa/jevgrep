import type { ImpactResult } from "@repo/core";

function quote(value: string): string {
  return JSON.stringify(value).replace(
    /[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

export function renderImpact(result: ImpactResult): string {
  const { target, callers, suspects, highRiskCount, status } = result;

  const lines: string[] = [
    `Jev Blast Radius: ${callers.length} consumer call site(s) found for ${quote(target.name)}.`,
    `High Risk Impacts: ${highRiskCount} caller(s) flagged for potential contract or behavioral breakdown.`,
  ];

  if (target.description) {
    lines.push(`Change Spec: ${quote(target.description)}`);
  }

  if (status === "no_callers") {
    lines.push(`No call sites or consumer references found for ${quote(target.name)} in the target repository.`);
    return lines.join("\n") + "\n\nEnd context.\n";
  }

  lines.push("", "Caller Risk Assessment:");

  for (const item of suspects) {
    const breakingPct = Math.round(item.breakingProbability * 100);
    const behavioralPct = Math.round(item.behavioralProbability * 100);
    const tag =
      item.riskLevel === "breaking_change"
        ? "[CRITICAL: BREAKING CHANGE]"
        : item.riskLevel === "potential_behavioral_change"
          ? "[WARNING: BEHAVIORAL RISK]"
          : item.riskLevel === "compatible_usage"
            ? "[COMPATIBLE]"
            : "[NO IMPACT]";

    lines.push(
      `- ${tag} ${quote(item.caller.path)} @ ${item.caller.name} (line ${item.caller.line})`,
      `  Breaking Risk: ${breakingPct}% | Behavioral Divergence: ${behavioralPct}% | Confidence: ${(item.confidence * 100).toFixed(0)}%`,
      `  Verdict: ${item.summary}`,
      `  Call site: ${item.caller.matchedReference}`,
    );
  }

  const critical = suspects.filter(
    (s) => s.riskLevel === "breaking_change" || s.riskLevel === "potential_behavioral_change",
  );

  if (critical.length > 0) {
    lines.push("", "High-Risk Caller Code Context:");
    for (const item of critical.slice(0, 3)) {
      lines.push(
        "",
        `Caller block ${quote(item.caller.path)} lines ${item.caller.range.startLine}-${item.caller.range.endLine}:`,
        "```",
        item.caller.source,
        "```",
      );
    }
  }

  return lines.join("\n") + "\n\nEnd context.\n";
}
