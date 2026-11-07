import { runConformance } from "@conclave/module-sdk/conformance";
import { describe, expect, it } from "vitest";
import mockModel from "./index";

describe("mock model", () => {
  it("passes the conformance kit", async () => {
    const report = await runConformance(mockModel);
    expect(report.checks.filter((c) => !c.passed)).toEqual([]);
    expect(report.passed).toBe(true);
  });
});
