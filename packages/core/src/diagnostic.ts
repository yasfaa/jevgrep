import { basename } from "node:path";
import { createFilesystem, type Snapshot } from "./filesystem";
import { inspect } from "./source";
import type { Evaluator, Range } from "./types";

export type StackFrame = {
  raw: string;
  file?: string;
  line?: number;
  column?: number;
  functionName?: string;
};

export type ParsedTrace = {
  raw: string;
  errorName?: string;
  errorMessage?: string;
  frames: StackFrame[];
  suspectFiles: string[];
};

export type DiagnosticCandidate = {
  path: string;
  name: string;
  range: Range;
  source: string;
  inTrace: boolean;
  frameIndex?: number;
};

export type DiagnosticSuspect = {
  candidate: DiagnosticCandidate;
  rootCauseProbability: number;
  secondaryPropagationProbability: number;
  confidence: number;
  verdict: "root_cause" | "propagated_symptom" | "unlikely";
};

export type DiagnosticResult = {
  trace: ParsedTrace;
  suspects: DiagnosticSuspect[];
  rankedRootCauses: DiagnosticSuspect[];
  status: "complete" | "incomplete" | "no_candidates";
};

/**
 * Parses Python, Node/V8, Go, or general stack traces into normalized frames and error signatures.
 */
export function parseStackTrace(trace: string): ParsedTrace {
  const lines = trace.split("\n");
  const frames: StackFrame[] = [];
  const suspectFiles = new Set<string>();
  let errorName: string | undefined;
  let errorMessage: string | undefined;

  // Python Traceback matcher: File "...", line 123, in foo
  const pyFrameRegex = /File\s+["']([^"']+)["'],\s+line\s+(\d+)(?:,\s+in\s+([^\n\r]+))?/;
  // Node / V8 stack matcher: at foo (path:line:col) or at path:line:col
  const v8FrameRegex = /^\s*at\s+(?:([^\s(]+)\s+\((.+):(\d+):(\d+)\)|(.+):(\d+):(\d+))/;
  // PHP / Laravel numbered stack matcher: #0 /path/to/file.php(123): Class->method()
  const phpFrameRegex = /^#\d+\s+(.*?)\((\d+)\)(?::\s*([^\n\r]+))?/;
  // Laravel Ignition / Whoops matcher: at App\Services\OrderService->process(...) in app/Services/OrderService.php:45
  const laravelIgnitionRegex = /at\s+([^\n\r]+?)\s+in\s+(.+?):(\d+)/;
  // Generic file:line matcher
  const genericLineRegex = /(?:^|\s)([\w./\\-]+\.[a-zA-Z0-9]+):(\d+)(?::(\d+))?/;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Check for PHP / Laravel fully qualified exception patterns:
    // e.g., "Illuminate\Database\QueryException: SQLSTATE[...]" or "App\Exceptions\CustomException: message"
    const phpExceptionMatch = trimmed.match(
      /^(?:\[\d{4}-\d{2}-\d{2}[^\]]*\]\s+[a-zA-Z0-9_]+:\s+)?(?:([a-zA-Z0-9_\\]+(?:Exception|Error|Throwable|Fault)):\s*(.*)|exception\s+'([a-zA-Z0-9_\\]+)'\s+with\s+message\s+'(.*)'(?:in\s+.*)?)/i,
    );
    if (phpExceptionMatch && !errorName) {
      errorName = (phpExceptionMatch[1] || phpExceptionMatch[3])?.replace(/^[\\/]+/, "");
      errorMessage = (phpExceptionMatch[2] || phpExceptionMatch[4])?.trim();
      continue;
    }

    // Check for standard Error/Exception name and message
    const errorMatch = trimmed.match(/^([A-Z][a-zA-Z0-9_]*(?:Error|Exception|Failure)):\s*(.*)$/);
    if (errorMatch && !errorName) {
      errorName = errorMatch[1];
      errorMessage = errorMatch[2];
      continue;
    }

    // PHP stack frame: #0 /path/to/file.php(45): App\Http\Controllers\OrderController->store()
    const phpMatch = trimmed.match(phpFrameRegex);
    if (phpMatch && phpMatch[1]) {
      const file = phpMatch[1].trim();
      const lineNum = Number(phpMatch[2]);
      const fnName = phpMatch[3]?.trim();
      frames.push({ raw: trimmed, file, line: lineNum, functionName: fnName });
      suspectFiles.add(file);
      continue;
    }

    // Laravel Ignition / Whoops frame: at App\Http\Controllers\OrderController->index() in app/Http/Controllers/OrderController.php:32
    const laravelMatch = trimmed.match(laravelIgnitionRegex);
    if (laravelMatch && laravelMatch[2]) {
      const fnName = laravelMatch[1]?.trim();
      const file = laravelMatch[2].trim();
      const lineNum = Number(laravelMatch[3]);
      frames.push({ raw: trimmed, file, line: lineNum, functionName: fnName });
      suspectFiles.add(file);
      continue;
    }

    const pyMatch = trimmed.match(pyFrameRegex);
    if (pyMatch) {
      const file = pyMatch[1]!;
      const lineNum = Number(pyMatch[2]);
      const fnName = pyMatch[3]?.trim();
      frames.push({ raw: trimmed, file, line: lineNum, functionName: fnName });
      suspectFiles.add(file);
      continue;
    }

    const v8Match = trimmed.match(v8FrameRegex);
    if (v8Match) {
      const fnName = v8Match[1]?.trim();
      const file = (v8Match[2] || v8Match[5])!;
      const lineNum = Number(v8Match[3] || v8Match[6]);
      const colNum = Number(v8Match[4] || v8Match[7]);
      frames.push({ raw: trimmed, file, line: lineNum, column: colNum, functionName: fnName });
      suspectFiles.add(file);
      continue;
    }

    const genMatch = trimmed.match(genericLineRegex);
    if (genMatch && !trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
      const file = genMatch[1]!;
      const lineNum = Number(genMatch[2]);
      const colNum = genMatch[3] ? Number(genMatch[3]) : undefined;
      frames.push({ raw: trimmed, file, line: lineNum, column: colNum });
      suspectFiles.add(file);
    }
  }

  // If no explicit error line matched, take the first non-empty line as summary
  if (!errorName && lines.length > 0) {
    const firstLine = lines.find((l) => l.trim().length > 0);
    if (firstLine) errorMessage = firstLine.trim();
  }

  return {
    raw: trace,
    errorName,
    errorMessage,
    frames,
    suspectFiles: [...suspectFiles],
  };
}

/**
 * Diagnoses a stack trace or failure log using Jev's calibrated probabilistic judgments.
 */
export async function diagnoseFailure(
  options: {
    trace: string;
    root: string;
    signal?: AbortSignal;
    policy?: Parameters<typeof createFilesystem>[0]["policy"];
  },
  evaluator: Evaluator,
): Promise<DiagnosticResult> {
  const parsedTrace = parseStackTrace(options.trace);
  const reader = await createFilesystem({
    root: options.root,
    policy: options.policy,
    signal: options.signal,
  });

  const candidates: DiagnosticCandidate[] = [];

  try {
    // 1. Gather suspect snapshots from files directly identified in the stack trace
    for (let fIdx = 0; fIdx < parsedTrace.frames.length; fIdx++) {
      options.signal?.throwIfAborted();
      const frame = parsedTrace.frames[fIdx]!;
      if (!frame.file) continue;

      // Match relative or base path
      const base = basename(frame.file);
      const snapshotResult = await reader.readSnapshot(frame.file).catch(() => null);

      let snapshot: Snapshot | null =
        snapshotResult && snapshotResult.status === "ok" ? snapshotResult.snapshot : null;

      if (!snapshot) {
        // Try looking up by relative basename in case the frame path is absolute from another machine
        const lookup = await reader.lookupFile(base);
        if (lookup.status === "file") {
          const res = await reader.readSnapshot(base);
          if (res.status === "ok") snapshot = res.snapshot;
        }
      }

      if (!snapshot) continue;

      const sourceLines = snapshot.source.split("\n");
      const syntax = await inspect(snapshot, { signal: options.signal });

      if (syntax.units.length > 0) {
        for (const unit of syntax.units) {
          // If frame line is inside unit or matches declaration name
          const containsLine =
            frame.line !== undefined &&
            unit.range.startLine <= frame.line &&
            unit.range.endLine >= frame.line;
          const matchesName =
            frame.functionName &&
            (unit.name === frame.functionName || unit.name.endsWith(`.${frame.functionName}`));

          if (containsLine || matchesName) {
            candidates.push({
              path: snapshot.path,
              name: unit.name,
              range: unit.range,
              source: sourceLines.slice(unit.range.startLine - 1, unit.range.endLine).join("\n"),
              inTrace: true,
              frameIndex: fIdx,
            });
          }
        }
      } else {
        // Fallback for languages without AST inspection (e.g. PHP) or unstructured files:
        // If a specific line was referenced in the frame, extract a targeted window around that line (±25 lines)
        let startLine = 1;
        let endLine = sourceLines.length;
        let candidateName = base;

        if (frame.line !== undefined && frame.line > 0 && frame.line <= sourceLines.length) {
          startLine = Math.max(1, frame.line - 25);
          endLine = Math.min(sourceLines.length, frame.line + 25);
          candidateName = frame.functionName
            ? `${base}:${frame.functionName}@${frame.line}`
            : `${base}:${frame.line}`;
        }

        candidates.push({
          path: snapshot.path,
          name: candidateName,
          range: { startLine, endLine },
          source: sourceLines.slice(startLine - 1, endLine).join("\n"),
          inTrace: true,
          frameIndex: fIdx,
        });
      }
    }

    if (!candidates.length) {
      return {
        trace: parsedTrace,
        suspects: [],
        rankedRootCauses: [],
        status: "no_candidates",
      };
    }

    // Deduplicate candidates
    const dedupedMap = new Map<string, DiagnosticCandidate>();
    for (const c of candidates) {
      const key = `${c.path}:${c.name}:${c.range.startLine}`;
      if (!dedupedMap.has(key)) dedupedMap.set(key, c);
    }
    const uniqueCandidates = [...dedupedMap.values()];

    // 2. Prepare Jev System One questions
    const questions: Record<string, { type: "boolean"; instructions: string }> = {};

    uniqueCandidates.forEach((candidate, i) => {
      questions[`root_${i}`] = {
        type: "boolean",
        instructions: `Given the error/stack trace: "${parsedTrace.errorName ?? "Error"}: ${parsedTrace.errorMessage ?? ""}", does the source of ${candidate.name} (lines ${candidate.range.startLine}-${candidate.range.endLine} in ${candidate.path}) contain the direct defect or trigger that creates this failure? Mark true ONLY if the logic itself is flawed or initiates the bad input/state, not if it merely crashes as an innocent caller or downstream recipient.`,
      };
      questions[`propagated_${i}`] = {
        type: "boolean",
        instructions: `Does ${candidate.name} merely receive already-corrupted state, null values, or unhandled exceptions propagated from upstream code? Mark true if this code is a secondary victim rather than the primary defect origin.`,
      };
    });

    const answers = await evaluator.evaluate({
      state: {
        error: {
          name: parsedTrace.errorName,
          message: parsedTrace.errorMessage,
          trace: parsedTrace.raw.slice(0, 4000),
        },
        candidates: uniqueCandidates.map((c) => ({
          path: c.path,
          name: c.name,
          lines: `${c.range.startLine}-${c.range.endLine}`,
          source: c.source.slice(0, 3000),
        })),
      },
      questions,
    });

    // 3. Assemble and rank suspects
    const suspects: DiagnosticSuspect[] = uniqueCandidates.map((candidate, i) => {
      const rootCauseProbability = answers[`root_${i}`] ?? 0;
      const secondaryPropagationProbability = answers[`propagated_${i}`] ?? 0;
      const confidence = Math.abs(rootCauseProbability - 0.5) * 2;

      let verdict: DiagnosticSuspect["verdict"] = "unlikely";
      if (rootCauseProbability >= 0.55 && rootCauseProbability > secondaryPropagationProbability) {
        verdict = "root_cause";
      } else if (secondaryPropagationProbability >= 0.5) {
        verdict = "propagated_symptom";
      }

      return {
        candidate,
        rootCauseProbability,
        secondaryPropagationProbability,
        confidence,
        verdict,
      };
    });

    // Sort by root cause probability descending
    const rankedRootCauses = suspects
      .filter((s) => s.verdict === "root_cause" || s.rootCauseProbability > 0.4)
      .sort((a, b) => b.rootCauseProbability - a.rootCauseProbability);

    return {
      trace: parsedTrace,
      suspects,
      rankedRootCauses,
      status: "complete",
    };
  } finally {
    await reader.close();
  }
}
