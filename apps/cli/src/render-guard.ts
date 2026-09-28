import type { GuardResult } from "@repo/core";

function quote(value: string): string {
  return JSON.stringify(value).replace(
    /[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

export function renderGuard(result: GuardResult): string {
  const { scannedFiles, inspectedBlocks, violations, criticalCount, warningCount, status } = result;

  const lines: string[] = [
    `Jev Guard Audit: ${scannedFiles} files scanned, ${inspectedBlocks} code blocks evaluated.`,
    `Violations: ${violations.length} total (${criticalCount} critical, ${warningCount} warnings).`,
  ];

  if (status === "empty") {
    lines.push("No candidate code declarations found matching the active guard rules.");
    return lines.join("\n") + "\n\nEnd context.\n";
  }

  if (status === "clean") {
    lines.push("No architectural or security guard violations detected. Clean audit.");
    return lines.join("\n") + "\n\nEnd context.\n";
  }

  lines.push("", "Detected Semantic Violations:");

  for (const v of violations) {
    const probPct = Math.round(v.violationProbability * 100);
    const tag = v.rule.severity === "critical" ? "[CRITICAL VIOLATION]" : "[POLICY WARNING]";

    lines.push(
      `- ${tag} ${v.rule.name} (${v.rule.category}): ${quote(v.path)} @ ${v.declarationName} (lines ${v.range.startLine}-${v.range.endLine})`,
      `  Probability: ${probPct}% | Confidence: ${(v.confidence * 100).toFixed(0)}%`,
      `  Description: ${v.rule.description}`,
    );
  }

  if (violations.length > 0) {
    lines.push("", "Violation Code Snippets:");
    for (const v of violations.slice(0, 3)) {
      lines.push(
        "",
        `Flagged block ${quote(v.path)} lines ${v.range.startLine}-${v.range.endLine} (${v.rule.name} - ${Math.round(v.violationProbability * 100)}% violation probability):`,
        "```",
        v.snippet,
        "```",
      );
    }
  }

  return lines.join("\n") + "\n\nEnd context.\n";
}
