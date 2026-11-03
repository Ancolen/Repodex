import { test, expect, describe } from "bun:test";
import { createSemaphore, mapWithConcurrency } from "../src/utils/concurrency";

describe("mapWithConcurrency", () => {
  test("returns empty on empty input", async () => {
    const out = await mapWithConcurrency([], 4, async (x) => x);
    expect(out).toEqual([]);
  });

  test("results preserve input order (even if workers finish at different times)", async () => {
    const items = [10, 1, 5, 2, 8, 3];
    const out = await mapWithConcurrency(items, 3, async (ms, i) => {
      // Larger value finishes later; we still expect ordered results.
      await new Promise((r) => setTimeout(r, ms));
      return i;
    });
    expect(out).toEqual([0, 1, 2, 3, 4, 5]);
  });

  test("number of concurrently running workers does not exceed the limit", async () => {
    const limit = 3;
    let active = 0;
    let maxActive = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    await mapWithConcurrency(items, limit, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    });
    expect(maxActive).toBeLessThanOrEqual(limit);
    expect(maxActive).toBeGreaterThan(1); // ran in parallel indeed
  });

  test("fail-fast if a worker throws an error (first error is propagated up)", async () => {
    const items = [1, 2, 3, 4];
    const call = mapWithConcurrency(items, 2, async (x) => {
      if (x === 2) throw new Error("exploded");
      await new Promise((r) => setTimeout(r, 5));
      return x;
    });
    await expect(call).rejects.toThrow("exploded");
  });

  test("works even if limit > number of elements", async () => {
    const out = await mapWithConcurrency([1, 2], 100, async (x) => x * 2);
    expect(out).toEqual([2, 4]);
  });
});

describe("createSemaphore", () => {
  test("caps concurrent holders at the limit", async () => {
    const sem = createSemaphore(2);
    let active = 0;
    let maxActive = 0;
    await Promise.all(
      Array.from({ length: 10 }, () =>
        sem.run(async () => {
          active++;
          maxActive = Math.max(maxActive, active);
          await new Promise((r) => setTimeout(r, 3));
          active--;
        }),
      ),
    );
    expect(maxActive).toBe(2);
  });

  test("releases the permit when the body throws", async () => {
    const sem = createSemaphore(1);
    await expect(sem.run(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(sem.run(async () => 42)).resolves.toBe(42);
  });

  test("a limit below 1 still admits one holder (never deadlocks)", async () => {
    const sem = createSemaphore(0);
    await expect(sem.run(async () => "ok")).resolves.toBe("ok");
  });
});
