import { basename } from "node:path";
import { createFilesystem, type Snapshot } from "./filesystem";
import { inspect } from "./source";
import type { Evaluator, Range } from "./types";

export type GuardRuleCategory = "security" | "architecture" | "reliability" | "custom";

export type GuardRule = {
  id: string;
  name: string;
  category: GuardRuleCategory;
  description: string;
  question: string;
  threshold?: number;
  severity: "critical" | "warning";
  applicableExtensions?: string[];
};

export type GuardViolation = {
  rule: GuardRule;
  path: string;
  declarationName: string;
  range: Range;
  snippet: string;
  violationProbability: number;
  confidence: number;
};

export type GuardResult = {
  scannedFiles: number;
  inspectedBlocks: number;
  violations: GuardViolation[];
  criticalCount: number;
  warningCount: number;
  status: "clean" | "violations_found" | "empty";
};

export const defaultGuardRules: GuardRule[] = [
  {
    id: "sec_credential_leak",
    name: "Credential or Secret Leakage",
    category: "security",
    severity: "critical",
    description: "Detects logging, printing, or transmitting raw passwords, secrets, or API keys.",
    question: "Does this code log, serialize into plain logs, or transmit in unencrypted/unmasked format any sensitive credentials, secret tokens, private keys, or passwords?",
    threshold: 0.65,
  },
  {
    id: "sec_unvalidated_injection",
    name: "Unsanitized Query or Shell Execution",
    category: "security",
    severity: "critical",
    description: "Detects raw SQL or shell commands built via direct string concatenation.",
    question: "Does this code construct raw SQL queries, shell commands, or operating system executions directly using unescaped or unparameterized user/string concatenation?",
    threshold: 0.70,
  },
  {
    id: "arch_layer_violation",
    name: "Architectural Layer Boundary Violation",
    category: "architecture",
    severity: "warning",
    description: "Detects presentation/controller layer code executing direct raw DB queries or bypassing service layers.",
    question: "Does this presentation, view, or controller layer code directly execute low-level database schema queries or bypass established service/repository boundaries?",
    threshold: 0.65,
    applicableExtensions: [".php", ".ts", ".js", ".py"],
  },
  {
    id: "rel_silent_error_swallowing",
    name: "Silent Error Suppression",
    category: "reliability",
    severity: "warning",
    description: "Detects catch/except blocks that completely swallow exceptions without logging or rethrowing.",
    question: "Does this catch or except block completely swallow and suppress an error or exception without logging, telemetry, or rethrowing, risking silent failures?",
    threshold: 0.70,
  },
];

/**
 * Runs semantic architectural and security compliance audits across the repository using Jev.
 */
export async function auditGuard(
  options: {
    root: string;
    rules?: GuardRule[];
    targetFiles?: string[];
    threshold?: number;
    signal?: AbortSignal;
    policy?: Parameters<typeof createFilesystem>[0]["policy"];
  },
  evaluator: Evaluator,
): Promise<GuardResult> {
  const reader = await createFilesystem({
    root: options.root,
    policy: options.policy,
    signal: options.signal,
  });

  const activeRules = options.rules ?? defaultGuardRules;
  const targetFilesSet = options.targetFiles ? new Set(options.targetFiles.map((p) => p.replace(/\\/g, "/"))) : null;

  type CandidateBlock = {
    path: string;
    declarationName: string;
    range: Range;
    snippet: string;
    applicableRules: GuardRule[];
  };

  const candidateBlocks: CandidateBlock[] = [];
  let scannedFiles = 0;

  try {
    const dirQueue: string[] = ["."];

    while (dirQueue.length > 0) {
      options.signal?.throwIfAborted();
      const currentDir = dirQueue.shift()!;
      let nextCursor: string | undefined;

      while (true) {
        options.signal?.throwIfAborted();
        const page = await reader.listPage(currentDir, nextCursor);

        for (const entry of page.entries) {
          if (entry.kind === "directory") {
            dirQueue.push(entry.path);
            continue;
          }

          const normalizedPath = entry.path.replace(/\\/g, "/");
          if (targetFilesSet && !targetFilesSet.has(normalizedPath) && !targetFilesSet.has(basename(normalizedPath))) {
            continue;
          }

          if (!/\.(?:[cm]?[jt]sx?|pyi?|php|go|rs|rb|java|cs)$/i.test(entry.path)) continue;

          const snapshotResult = await reader.readSnapshot(entry.path).catch(() => null);
          if (!snapshotResult || snapshotResult.status !== "ok") continue;

          scannedFiles++;
          const snapshot: Snapshot = snapshotResult.snapshot;
          const ext = "." + (snapshot.path.split(".").pop() ?? "");
          const matchingRules = activeRules.filter(
            (r) => !r.applicableExtensions || r.applicableExtensions.includes(ext),
          );

          if (!matchingRules.length) continue;

          const sourceLines = snapshot.source.split("\n");
          const syntax = await inspect(snapshot, { signal: options.signal });

          if (syntax.units.length > 0) {
            for (const unit of syntax.units) {
              if (unit.name.endsWith(".context")) continue;
              const unitSnippet = sourceLines.slice(unit.range.startLine - 1, unit.range.endLine).join("\n");
              if (unitSnippet.trim().length < 20) continue;

              candidateBlocks.push({
                path: snapshot.path,
                declarationName: unit.name,
                range: unit.range,
                snippet: unitSnippet.slice(0, 3000),
                applicableRules: matchingRules,
              });
            }
          } else {
            // For languages without AST breakdown (like PHP), chunk into logical chunks (e.g. 50 lines)
            const chunkSize = 50;
            for (let i = 0; i < sourceLines.length; i += chunkSize) {
              const startLine = i + 1;
              const endLine = Math.min(sourceLines.length, i + chunkSize);
              const chunkText = sourceLines.slice(startLine - 1, endLine).join("\n");
              if (chunkText.trim().length < 20) continue;

              candidateBlocks.push({
                path: snapshot.path,
                declarationName: `${basename(snapshot.path)}:${startLine}-${endLine}`,
                range: { startLine, endLine },
                snippet: chunkText.slice(0, 3000),
                applicableRules: matchingRules,
              });
            }
          }
        }

        if (!page.nextCursor) break;
        nextCursor = page.nextCursor;
      }
    }

    if (!candidateBlocks.length) {
      return {
        scannedFiles,
        inspectedBlocks: 0,
        violations: [],
        criticalCount: 0,
        warningCount: 0,
        status: "empty",
      };
    }

    // Limit evaluation batches to prevent unbounded token usage on huge repos
    const sampleBlocks = candidateBlocks.slice(0, 100);
    const questions: Record<string, { type: "boolean"; instructions: string }> = {};

    sampleBlocks.forEach((block, bIdx) => {
      block.applicableRules.forEach((rule, rIdx) => {
        questions[`v_${bIdx}_${rIdx}`] = {
          type: "boolean",
          instructions: `${rule.question} Evaluate ONLY this code block in ${block.path} (${block.declarationName}).`,
        };
      });
    });

    const answers = await evaluator.evaluate({
      state: {
        auditSummary: "Semantic architecture and security verification",
        blocks: sampleBlocks.map((b) => ({
          path: b.path,
          name: b.declarationName,
          lines: `${b.range.startLine}-${b.range.endLine}`,
          source: b.snippet,
        })),
      },
      questions,
    });

    const violations: GuardViolation[] = [];

    sampleBlocks.forEach((block, bIdx) => {
      block.applicableRules.forEach((rule, rIdx) => {
        const violationProbability = answers[`v_${bIdx}_${rIdx}`] ?? 0;
        const effectiveThreshold = options.threshold ?? rule.threshold ?? 0.65;

        if (violationProbability >= effectiveThreshold) {
          violations.push({
            rule,
            path: block.path,
            declarationName: block.declarationName,
            range: block.range,
            snippet: block.snippet,
            violationProbability,
            confidence: Math.abs(violationProbability - 0.5) * 2,
          });
        }
      });
    });

    // Sort violations by severity (critical first) then by probability descending
    violations.sort((a, b) => {
      if (a.rule.severity !== b.rule.severity) {
        return a.rule.severity === "critical" ? -1 : 1;
      }
      return b.violationProbability - a.violationProbability;
    });

    const criticalCount = violations.filter((v) => v.rule.severity === "critical").length;
    const warningCount = violations.filter((v) => v.rule.severity === "warning").length;

    return {
      scannedFiles,
      inspectedBlocks: sampleBlocks.length,
      violations,
      criticalCount,
      warningCount,
      status: violations.length > 0 ? "violations_found" : "clean",
    };
  } finally {
    await reader.close();
  }
}
