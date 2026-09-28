import { basename } from "node:path";
import { createFilesystem, type Snapshot } from "./filesystem";
import { inspect } from "./source";
import type { Evaluator, Range } from "./types";

export type ImpactRiskLevel = "no_impact" | "compatible_usage" | "potential_behavioral_change" | "breaking_change";

export type TargetSymbol = {
  path?: string;
  name: string;
  signature?: string;
  description?: string;
  declaration?: {
    range: Range;
    source: string;
  };
};

export type CallerCandidate = {
  path: string;
  name: string;
  range: Range;
  source: string;
  matchedReference: string;
  line: number;
};

export type ImpactSuspect = {
  caller: CallerCandidate;
  riskLevel: ImpactRiskLevel;
  breakingProbability: number;
  behavioralProbability: number;
  compatibleProbability: number;
  confidence: number;
  summary: string;
};

export type ImpactResult = {
  target: TargetSymbol;
  callers: CallerCandidate[];
  suspects: ImpactSuspect[];
  highRiskCount: number;
  status: "complete" | "incomplete" | "no_callers";
};

/**
 * Escapes regex special characters in a string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Analyzes semantic blast radius and breaking change risk across consumers/callers of a symbol.
 */
export async function analyzeImpact(
  options: {
    symbol: string;
    root: string;
    signal?: AbortSignal;
    targetPath?: string;
    description?: string;
    policy?: Parameters<typeof createFilesystem>[0]["policy"];
  },
  evaluator: Evaluator,
): Promise<ImpactResult> {
  const reader = await createFilesystem({
    root: options.root,
    policy: options.policy,
    signal: options.signal,
  });

  const callers: CallerCandidate[] = [];
  let targetDeclaration: TargetSymbol["declaration"] | undefined;

  try {
    const symbolParts = options.symbol.split(/[.:#->\\]+/).filter(Boolean);
    const primaryName = symbolParts.at(-1) ?? options.symbol;
    const regexPattern = new RegExp(`\\b${escapeRegex(primaryName)}\\b`);

    // Traverse directory tree recursively using a queue to find occurrences across subdirectories
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

          if (!/\.(?:[cm]?[jt]sx?|pyi?|php|go|rs|rb|java|cs)$/i.test(entry.path)) continue;

          const snapshotResult = await reader.readSnapshot(entry.path).catch(() => null);
          if (!snapshotResult || snapshotResult.status !== "ok") continue;

          const snapshot: Snapshot = snapshotResult.snapshot;
          if (!regexPattern.test(snapshot.source)) continue;

          const sourceLines = snapshot.source.split("\n");
          const syntax = await inspect(snapshot, { signal: options.signal });

          for (let lineIdx = 0; lineIdx < sourceLines.length; lineIdx++) {
            const lineNum = lineIdx + 1;
            const lineText = sourceLines[lineIdx]!;
            if (!regexPattern.test(lineText)) continue;

            // Check if this line is part of the target declaration definition itself
            const isTargetFile = !options.targetPath || snapshot.path.endsWith(options.targetPath);
            const isDefinition = /(?:function|def|class|interface|type|const|public|protected|private)\s+/.test(lineText);

            if (isTargetFile && isDefinition && !targetDeclaration) {
              targetDeclaration = {
                range: {
                  startLine: Math.max(1, lineNum - 2),
                  endLine: Math.min(sourceLines.length, lineNum + 20),
                },
                source: sourceLines
                  .slice(Math.max(0, lineNum - 3), Math.min(sourceLines.length, lineNum + 20))
                  .join("\n"),
              };
            }

            // Otherwise, find which unit/function encloses this call
            let enclosingUnit = syntax.units.find(
              (u) => u.range.startLine <= lineNum && u.range.endLine >= lineNum,
            );

            let startLine = enclosingUnit ? enclosingUnit.range.startLine : Math.max(1, lineNum - 15);
            let endLine = enclosingUnit ? enclosingUnit.range.endLine : Math.min(sourceLines.length, lineNum + 15);
            let callerName = enclosingUnit ? enclosingUnit.name : `${basename(snapshot.path)}:${lineNum}`;

            callers.push({
              path: snapshot.path,
              name: callerName,
              range: { startLine, endLine },
              source: sourceLines.slice(startLine - 1, endLine).join("\n"),
              matchedReference: lineText.trim(),
              line: lineNum,
            });
          }
        }

        if (!page.nextCursor) break;
        nextCursor = page.nextCursor;
      }
    }

    // Deduplicate callers by file and function range
    const dedupedCallers = new Map<string, CallerCandidate>();
    for (const caller of callers) {
      const key = `${caller.path}:${caller.name}:${caller.range.startLine}`;
      if (!dedupedCallers.has(key)) {
        dedupedCallers.set(key, caller);
      }
    }
    const uniqueCallers = [...dedupedCallers.values()];

    const target: TargetSymbol = {
      name: options.symbol,
      path: options.targetPath,
      description: options.description,
      declaration: targetDeclaration,
    };

    if (!uniqueCallers.length) {
      return {
        target,
        callers: [],
        suspects: [],
        highRiskCount: 0,
        status: "no_callers",
      };
    }

    // Evaluate risk probabilities using Jev calibrated boolean questions
    const questions: Record<string, { type: "boolean"; instructions: string }> = {};

    uniqueCallers.forEach((caller, i) => {
      questions[`breaking_${i}`] = {
        type: "boolean",
        instructions: `Given modifying or altering the behavior of '${options.symbol}' ${options.description ? `(${options.description})` : ""}, will caller '${caller.name}' (in ${caller.path}) suffer a direct breaking contract failure, runtime exception, or invalid type signature? Mark true if changing the target directly breaks this consumer.`,
      };
      questions[`behavioral_${i}`] = {
        type: "boolean",
        instructions: `Does caller '${caller.name}' rely on subtle side effects, return value ordering, internal state mutation, or implicit assumptions of '${options.symbol}' that could silently malfunction?`,
      };
      questions[`compatible_${i}`] = {
        type: "boolean",
        instructions: `Is caller '${caller.name}' safely insulated, using the standard public interface normally, or easily tolerant to typical internal modifications of '${options.symbol}'?`,
      };
    });

    const answers = await evaluator.evaluate({
      state: {
        target: {
          symbol: options.symbol,
          description: options.description ?? "Interface or behavior alteration",
          declarationSnippet: targetDeclaration?.source?.slice(0, 3000),
        },
        callers: uniqueCallers.map((c) => ({
          callerName: c.name,
          path: c.path,
          callSite: c.matchedReference,
          callerSource: c.source.slice(0, 3000),
        })),
      },
      questions,
    });

    const suspects: ImpactSuspect[] = uniqueCallers.map((caller, i) => {
      const breakingProbability = answers[`breaking_${i}`] ?? 0;
      const behavioralProbability = answers[`behavioral_${i}`] ?? 0;
      const compatibleProbability = answers[`compatible_${i}`] ?? 0;

      let riskLevel: ImpactRiskLevel = "compatible_usage";
      let summary = "Standard, compatible consumption.";

      if (breakingProbability >= 0.5) {
        riskLevel = "breaking_change";
        summary = "High probability of signature/interface contract breakdown or crash.";
      } else if (behavioralProbability >= 0.5 || breakingProbability >= 0.35) {
        riskLevel = "potential_behavioral_change";
        summary = "Potential behavioral divergence or assumption mismatch.";
      } else if (compatibleProbability < 0.4) {
        riskLevel = "no_impact";
        summary = "Uncertain or minimal direct functional coupling.";
      }

      const confidence = Math.max(breakingProbability, behavioralProbability, compatibleProbability);

      return {
        caller,
        riskLevel,
        breakingProbability,
        behavioralProbability,
        compatibleProbability,
        confidence,
        summary,
      };
    });

    // Sort suspects: breaking first, then behavioral, then by breaking probability descending
    suspects.sort((a, b) => {
      const order: Record<ImpactRiskLevel, number> = {
        breaking_change: 3,
        potential_behavioral_change: 2,
        compatible_usage: 1,
        no_impact: 0,
      };
      return order[b.riskLevel] - order[a.riskLevel] || b.breakingProbability - a.breakingProbability;
    });

    const highRiskCount = suspects.filter(
      (s) => s.riskLevel === "breaking_change" || s.riskLevel === "potential_behavioral_change",
    ).length;

    return {
      target,
      callers: uniqueCallers,
      suspects,
      highRiskCount,
      status: "complete",
    };
  } finally {
    await reader.close();
  }
}
