import { test, expect } from "bun:test";
import { analyzeImpact } from "../src/impact";
import type { Evaluator } from "../src/types";

test("analyzeImpact correctly identifies callers and runs mock calibrated evaluation", async () => {
  const mockEvaluator: Evaluator = {
    cacheHits: 0,
    cacheIssues: [],
    requests: 0,
    evaluate: async (req) => {
      const answers: Record<string, number> = {};
      for (const key of Object.keys(req.questions)) {
        if (key.startsWith("breaking_")) answers[key] = 0.85;
        else if (key.startsWith("behavioral_")) answers[key] = 0.40;
        else if (key.startsWith("compatible_")) answers[key] = 0.10;
      }
      return answers;
    },
  };

  const result = await analyzeImpact(
    {
      symbol: "parseCommand",
      root: process.cwd(),
      description: "Changing arguments order and return structure",
    },
    mockEvaluator,
  );

  expect(result.target.name).toBe("parseCommand");
  expect(result.status).toBe("complete");
  expect(result.callers.length).toBeGreaterThan(0);
  expect(result.suspects.length).toBe(result.callers.length);
  expect(result.highRiskCount).toBeGreaterThan(0);
  expect(result.suspects[0]?.riskLevel).toBe("breaking_change");
  expect(result.suspects[0]?.breakingProbability).toBe(0.85);
});
