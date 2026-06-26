/**
 * T002 — MCP tool result truncation tests
 * Imports TOOL_RESULT_MAX_CHARS and truncateToolResult from production code.
 */

import { describe, expect, it } from "vitest";
import { TOOL_RESULT_MAX_CHARS, truncateToolResult } from "../index.ts";

describe("T002: MCP tool result truncation", () => {
  it("returns content as-is when under limit", () => {
    const result = truncateToolResult([{ type: "text", text: "x".repeat(100) }]);
    expect(result).toBe("x".repeat(100));
    expect(result).not.toContain("[truncated");
  });

  it("returns content as-is when exactly at limit", () => {
    const result = truncateToolResult([{ type: "text", text: "a".repeat(TOOL_RESULT_MAX_CHARS) }]);
    expect(result.length).toBe(TOOL_RESULT_MAX_CHARS);
    expect(result).not.toContain("[truncated");
  });

  it("truncates content over the limit", () => {
    const result = truncateToolResult([{ type: "text", text: "b".repeat(TOOL_RESULT_MAX_CHARS + 500) }]);
    expect(result).toContain("[truncated");
    expect(result.length).toBeLessThan(TOOL_RESULT_MAX_CHARS + 500);
  });

  it("includes correct omitted char count in truncation note", () => {
    const over = 1000;
    const result = truncateToolResult([{ type: "text", text: "c".repeat(TOOL_RESULT_MAX_CHARS + over) }]);
    expect(result).toContain(`${over} chars omitted`);
  });

  it("joins multiple content blocks then truncates", () => {
    const blocks = [
      { type: "text", text: "a".repeat(5000) },
      { type: "text", text: "b".repeat(5000) },
    ];
    const result = truncateToolResult(blocks);
    expect(result).toContain("[truncated");
  });

  it("returns empty string for empty content", () => {
    expect(truncateToolResult([])).toBe("");
    expect(truncateToolResult([{ type: "text", text: "" }])).toBe("");
  });
});
