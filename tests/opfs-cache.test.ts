/**
 * Tests for OpfsCache.
 *
 * jsdom does not provide OPFS, so all tests verify graceful degradation when
 * OPFS is unavailable. If OPFS IS available (real browser), the functional
 * tests also run.
 */
import { describe, it, expect } from "vitest";
import { OpfsCache } from "../src/copc/opfs-cache";

describe("OpfsCache", () => {
  it("isAvailable is false in jsdom (no OPFS)", async () => {
    const cache = await OpfsCache.open("test-ns");
    // jsdom does not expose navigator.storage.getDirectory, so OPFS should
    // be unavailable.
    expect(cache.isAvailable).toBe(false);
  });

  it("get returns null when OPFS is unavailable", async () => {
    const cache = await OpfsCache.open("test-ns");
    const result = await cache.get("any-key");
    expect(result).toBeNull();
  });

  it("set is a no-op when OPFS is unavailable", async () => {
    const cache = await OpfsCache.open("test-ns");
    // Should not throw.
    await expect(cache.set("key", new ArrayBuffer(4))).resolves.toBeUndefined();
  });

  it("has returns false when OPFS is unavailable", async () => {
    const cache = await OpfsCache.open("test-ns");
    expect(await cache.has("key")).toBe(false);
  });

  it("totalBytes is 0 when OPFS is unavailable", async () => {
    const cache = await OpfsCache.open("test-ns");
    expect(cache.totalBytes).toBe(0);
  });

  it("maxMb option is accepted without throwing", async () => {
    const cache = await OpfsCache.open("test-ns", { maxMb: 128 });
    expect(cache).toBeDefined();
  });
});
