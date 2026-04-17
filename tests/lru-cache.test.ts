import { describe, it, expect } from "vitest";
import { LruCache } from "../src/copc/lru-cache";

describe("LruCache", () => {
  it("stores and retrieves values", () => {
    const cache = new LruCache<string, number>(5);
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.get("a")).toBe(1);
    expect(cache.get("b")).toBe(2);
  });

  it("evicts the least-recently-used entry when full", () => {
    const cache = new LruCache<string, number>(3);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    // Access "a" to make it recently used; "b" becomes LRU.
    cache.get("a");
    cache.set("d", 4); // should evict "b"
    expect(cache.has("b")).toBe(false);
    expect(cache.has("a")).toBe(true);
    expect(cache.has("c")).toBe(true);
    expect(cache.has("d")).toBe(true);
  });

  it("respects maxEntries capacity", () => {
    const cache = new LruCache<number, number>(2);
    cache.set(1, 10);
    cache.set(2, 20);
    cache.set(3, 30); // evicts 1
    expect(cache.size).toBe(2);
    expect(cache.has(1)).toBe(false);
    expect(cache.has(2)).toBe(true);
    expect(cache.has(3)).toBe(true);
  });

  it("updates existing key and refreshes recency", () => {
    const cache = new LruCache<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    // Update "a" — it becomes most recently used, "b" is now LRU.
    cache.set("a", 99);
    cache.set("c", 3); // evicts "b"
    expect(cache.get("a")).toBe(99);
    expect(cache.has("b")).toBe(false);
    expect(cache.has("c")).toBe(true);
  });

  it("delete removes an entry", () => {
    const cache = new LruCache<string, number>(5);
    cache.set("x", 42);
    expect(cache.has("x")).toBe(true);
    cache.delete("x");
    expect(cache.has("x")).toBe(false);
    expect(cache.get("x")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("returns undefined for missing key", () => {
    const cache = new LruCache<string, number>(5);
    expect(cache.get("missing")).toBeUndefined();
  });

  it("throws for maxEntries < 1", () => {
    expect(() => new LruCache(0)).toThrow();
  });
});
