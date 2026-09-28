import { describe, expect, test } from "bun:test";
import { auditGuard, type GuardRule } from "../src/guard";
import type { Evaluator } from "../src/types";

describe("auditGuard", () => {
  test("detects violations when evaluator reports high probability", async () => {
    const mockRule: GuardRule = {
      id: "test-rule",
      name: "Test Rule",
      category: "security",
      description: "Detects parseCommand usage",
      question: "Is this block constructing commands?",
      severity: "critical",
      threshold: 0.7,
    };

    const mockEvaluator: Evaluator = {
      cacheHits: 0,
      cacheIssues: [],
      requests: 0,
      evaluate: async (req) => {
        const answers: Record<string, number> = {};
        for (const key of Object.keys(req.questions)) {
          answers[key] = 0.95;
        }
        return answers;
      },
    };

    const result = await auditGuard(
      {
        root: process.cwd(),
        rules: [mockRule],
        threshold: 0.7,
      },
      mockEvaluator,
    );

    expect(result.status).toBe("violations_found");
    expect(result.scannedFiles).toBeGreaterThan(0);
    expect(result.violations.length).toBeGreaterThan(0);
    expect(result.criticalCount).toBeGreaterThan(0);
    expect(result.violations[0].rule.id).toBe("test-rule");
    expect(result.violations[0].violationProbability).toBe(0.95);
  });

  test("filters out blocks below threshold", async () => {
    const mockRule: GuardRule = {
      id: "test-rule",
      name: "Test Rule",
      category: "security",
      description: "Detects parseCommand usage",
      question: "Is this block constructing commands?",
      severity: "critical",
      threshold: 0.7,
    };

    const mockEvaluator: Evaluator = {
      cacheHits: 0,
      cacheIssues: [],
      requests: 0,
      evaluate: async (req) => {
        const answers: Record<string, number> = {};
        for (const key of Object.keys(req.questions)) {
          answers[key] = 0.2;
        }
        return answers;
      },
    };

    const result = await auditGuard(
      {
        root: process.cwd(),
        rules: [mockRule],
        threshold: 0.7,
      },
      mockEvaluator,
    );

    expect(result.status).toBe("clean");
    expect(result.scannedFiles).toBeGreaterThan(0);
    expect(result.violations.length).toBe(0);
    expect(result.criticalCount).toBe(0);
  });
});
