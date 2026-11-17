import { describe, expect, it } from "vitest";
import { MEASURED_SYSTEM, MEASURED_TOOLS, TOKEN_BUDGET, buildSystem, emptyState, estimatePromptTokens, toolDefs, toolSchemas } from "../../src";

describe("prompt y herramientas", () => {
  it("system + tools ≤ 2.500 tokens (estimación de ~3,5 caracteres por token)", () => {
    const est = estimatePromptTokens();
    console.log(`estimated tokens: system=${est.system} tools=${est.tools} total=${est.total}`);
    expect(est.total).toBeLessThanOrEqual(TOKEN_BUDGET);
  });

  it("una definición por herramienta, sin $schema", () => {
    expect(toolDefs.map((t) => t.name).sort()).toEqual(Object.keys(toolSchemas).sort());
    expect(MEASURED_TOOLS).toBe(toolDefs);
    expect(JSON.stringify(toolDefs)).not.toMatch(/\$schema|additionalProperties/);
    expect(MEASURED_SYSTEM).toBe(buildSystem({ state: emptyState() }));
  });

  it("sin tecnicismos en el prompt visible para la usuaria", () => {
    expect(MEASURED_SYSTEM).toContain("vos");
  });
});
