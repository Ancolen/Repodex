/**
 * Local tool-usage analytics (2.10.0).
 *
 * The estimators are pure (the file `stat` is injected); the registry stores
 * one bounded row per tool call with the query-log contract (write-time prune,
 * 0 = off, failures never propagate). The `usage_log` table lives in a temp
 * sqlite file — no daemon, no LanceDB.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { UsageLogRow } from "../src/core/registry";

const { Registry } = await import("../src/core/registry");
const {
  estimatePayloadChars,
  estimateReturnedTokens,
  estimateToolUsage,
  uniqueFilePaths,
  MAX_PAYLOAD_CHARS,
  MAX_AVOIDED_FILES,
} = await import("../src/core/usage");
const { formatUsageStats } = await import("../src/server/format");

describe("usage estimators (pure)", () => {
  test("payload chars = text + structured, capped", () => {
    expect(estimatePayloadChars("abcd", { x: "y" })).toBe(4 + '{"x":"y"}'.length);
    expect(estimatePayloadChars(undefined, undefined)).toBe(0);
    expect(estimatePayloadChars("x".repeat(MAX_PAYLOAD_CHARS * 2), undefined)).toBe(MAX_PAYLOAD_CHARS);
  });

  test("returned tokens ceil on the chars/4 default and never divide by zero", () => {
    expect(estimateReturnedTokens(0)).toBe(0);
    expect(estimateReturnedTokens(1)).toBe(1);
    expect(estimateReturnedTokens(5)).toBe(2);
    expect(estimateReturnedTokens(400)).toBe(100);
    expect(estimateReturnedTokens(400, 0)).toBe(100);
    expect(estimateReturnedTokens(30, 3)).toBe(10);
  });

  test("uniqueFilePaths walks nested payloads, dedupes, and caps", () => {
    const payload = {
      results: [
        { filePath: "/a.ts", content: "x" },
        { filePath: "/a.ts", content: "y" },
        { nested: { filePath: "/b.ts" } },
      ],
      groups: [{ results: [{ filePath: "/c.ts" }] }],
    };
    expect(uniqueFilePaths(payload).sort()).toEqual(["/a.ts", "/b.ts", "/c.ts"]);
    const many = Array.from({ length: MAX_AVOIDED_FILES + 20 }, (_, i) => ({ filePath: `/f${i}.ts` }));
    expect(uniqueFilePaths({ results: many })).toHaveLength(MAX_AVOIDED_FILES);
  });

  test("avoided = full-file tokens − returned tokens, clamped at 0", () => {
    const sizes: Record<string, number> = { "/a.ts": 4000, "/b.ts": 400 };
    const sizeOfFile = (p: string) => sizes[p] ?? null;
    const structured = { results: [{ filePath: "/a.ts" }, { filePath: "/b.ts" }] };

    const saved = estimateToolUsage({
      tool: "search_codebase",
      text: "x".repeat(400), // 100 tokens returned
      structured,
      charsPerToken: 4,
      sizeOfFile,
    });
    // 4400 bytes = 1100 tokens of files − 100 returned (+ structured chars).
    expect(saved.estReturnedTokens).toBeGreaterThan(100);
    expect(saved.estAvoidedTokens).toBeGreaterThan(900);

    const dumped = estimateToolUsage({
      tool: "search_codebase",
      text: "x".repeat(20_000), // more than the files
      structured,
      charsPerToken: 4,
      sizeOfFile,
    });
    expect(dumped.estAvoidedTokens).toBe(0);

    const report = estimateToolUsage({
      tool: "get_index_status",
      text: "x".repeat(400),
      structured,
      charsPerToken: 4,
      sizeOfFile,
    });
    expect(report.estAvoidedTokens).toBe(0); // not a content-returning tool
  });
});

describe("Registry usage_log", () => {
  let dir: string;
  let reg: InstanceType<typeof Registry>;

  const row = (overrides: Partial<UsageLogRow> = {}): UsageLogRow => ({
    ts: Date.now(),
    tool: "search_codebase",
    project: null,
    ok: true,
    returnedChars: 400,
    estReturnedTokens: 100,
    estAvoidedTokens: 900,
    latencyMs: 12,
    ...overrides,
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), `cidx-usage-${randomUUID()}-`));
    reg = new Registry(join(dir, "meta.db"));
  });

  afterEach(() => {
    reg.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("records, aggregates per tool, and counts failures", () => {
    reg.recordUsage(row({ tool: "search_codebase", project: "api" }));
    reg.recordUsage(row({ tool: "search_codebase", project: "api", ok: false, latencyMs: 30 }));
    reg.recordUsage(row({ tool: "find_symbol", project: "api", estReturnedTokens: 10, estAvoidedTokens: 40 }));
    expect(reg.countUsageLog()).toBe(3);

    const all = reg.usageStats();
    expect(all.totalCalls).toBe(3);
    expect(all.okCalls).toBe(2);
    expect(all.failedCalls).toBe(1);
    expect(all.estReturnedTokens).toBe(210);
    expect(all.estAvoidedTokens).toBe(1840);
    expect(all.tools[0]!.tool).toBe("search_codebase");
    expect(all.tools[0]!.calls).toBe(2);
    expect(all.tools[0]!.failed).toBe(1);

    const api = reg.usageStats({ project: "api" });
    expect(api.totalCalls).toBe(3);
    expect(reg.usageStats({ project: "other" }).totalCalls).toBe(0);
  });

  test("days narrows the window and reports it", () => {
    const old = Date.now() - 40 * 86_400_000;
    reg.recordUsage(row({ ts: old }));
    reg.recordUsage(row());
    expect(reg.usageStats().totalCalls).toBe(2);
    const week = reg.usageStats({ days: 7 });
    expect(week.totalCalls).toBe(1);
    expect(week.days).toBe(7);
  });

  test("write-time pruning keeps the newest rows; 0 = off", () => {
    for (let i = 0; i < 5; i++) reg.recordUsage(row({ tool: `t${i}` }), 3);
    expect(reg.countUsageLog()).toBe(3);
    expect(reg.pruneUsageLog(0)).toBe(3);
    expect(reg.countUsageLog()).toBe(0);

    // Off mode: no write, no prune.
    reg.recordUsage(row(), 0);
    expect(reg.countUsageLog()).toBe(0);
  });

  test("formatUsageStats renders totals, per-tool rows and the estimate disclaimer", () => {
    reg.recordUsage(row({ tool: "search_codebase", project: "api" }));
    const text = formatUsageStats(reg.usageStats());
    expect(text).toContain("1 call(s)");
    expect(text).toContain("search_codebase");
    expect(text).toContain("Estimates only");
    expect(formatUsageStats(reg.usageStats({ project: "none" }))).toContain("No tool calls recorded yet");
  });
});
