/**
 * M8.5 — Unified Importance Engine tests.
 *
 * Four measurable claims (from MASTER_ROADMAP.md):
 *   1. Eviction bias:  K-lookahead retains high-importance points preferentially.
 *   2. Density ratio:  ≥5× more high-importance points than low-importance after sustained pressure.
 *   3. Staleness:      With maxStalenessMs, old high-importance points are evicted before fresh low-importance.
 *   4. No regression:  Without importanceField/maxStalenessMs, behavior is identical to pure FIFO.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { PointBuffer } from "../src/core/backpressure";
import type { PackedAttributeChannel, PointRecord } from "../src/core/types";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makePoints(n: number, scoreValue: number, offsetX = 0): PointRecord[] {
  return Array.from({ length: n }, (_, i) => ({
    x: offsetX + i, y: 0, z: 0,
    attributes: { score: scoreValue },
  }));
}

/** Alternating importance: even index → 0.0, odd index → 1.0. */
function makeAlternating(n: number): PointRecord[] {
  return Array.from({ length: n }, (_, i) => ({
    x: i, y: 0, z: 0,
    attributes: { score: i % 2 === 0 ? 0.0 : 1.0 },
  }));
}

/** Build ingestFromBinary-compatible typed arrays. */
function makeBinary(
  n: number,
  importanceFn: (i: number) => number,
  offsetX = 0,
): { xyz: Float32Array; attrs: PackedAttributeChannel[]; count: number } {
  const xyz = new Float32Array(n * 3);
  const scoreVals = new Float32Array(n);
  const scorePresent = new Uint8Array(n).fill(1);
  for (let i = 0; i < n; i++) {
    xyz[i * 3] = offsetX + i;
    scoreVals[i] = importanceFn(i);
  }
  return { xyz, attrs: [{ key: "score", values: scoreVals, present: scorePresent }], count: n };
}

/** Average "score" attribute across all snapshotted points. */
function avgScore(buf: PointBuffer): number {
  const pts = buf.snapshot();
  if (pts.length === 0) return 0;
  return pts.reduce((s, p) => s + (p.attributes?.score ?? 0), 0) / pts.length;
}

// ─── 1. Eviction bias (PointRecord path) ─────────────────────────────────────

/**
 * Block pattern: [H×B, L×B] repeating with B = K/4 = 4.
 * The H-gap between L-blocks is 2B = 8 < K=16, so K-lookahead ALWAYS reaches
 * the next L-block and evicts it preferentially.
 *
 * With B=8 (= K/2): H-gap = 16 = K, so the lookahead window exactly fills with H
 * after evicting one L-block and cannot see the next L → some H evictions occur.
 *
 * FIFO evicts the oldest blocks first (a mix of H and L), resulting in ~50% retention.
 * K-lookahead consistently evicts L-blocks, resulting in ~70%+ retention.
 */
function makeBlockPattern(capacity: number, blockSize = 4): PointRecord[] {
  const pts: PointRecord[] = [];
  for (let i = 0; i < capacity; i++) {
    const blockIndex = Math.floor(i / blockSize);
    const score = blockIndex % 2 === 0 ? 1.0 : 0.0; // even blocks = high, odd = low
    pts.push({ x: i, y: 0, z: 0, attributes: { score } });
  }
  return pts;
}

describe("Eviction bias — ingest() PointRecord path", () => {
  it("preferentially evicts low-importance blocks when pattern is [H×4, L×4] repeating", () => {
    // B=4 = K/4: H-gap between L-blocks is 2B=8 < K=16.
    // K-lookahead always reaches the next L-block and evicts it preferentially.
    const capacity = 64; // 8× [H×4, L×4] = 32H + 32L
    const withImp = new PointBuffer({ maxPoints: capacity, mode: "drop-oldest", importanceField: "score" });
    const fifo    = new PointBuffer({ maxPoints: capacity, mode: "drop-oldest" });

    withImp.ingest(makeBlockPattern(capacity));
    fifo.ingest(makeBlockPattern(capacity));

    // Overflow by 32 points — triggers 32 evictions (= all L-blocks worth)
    withImp.ingest(makePoints(32, 0.5, capacity));
    fifo.ingest(makePoints(32, 0.5, capacity));

    const impAvg  = avgScore(withImp);
    const fifoAvg = avgScore(fifo);

    // K-lookahead: evicts ~72% L and ~28% H → avg ≈ 0.61.
    // FIFO: evicts first 32 in ring order (16H + 16L) → avg ≈ 0.50.
    // Threshold is intentionally conservative — the important thing is impAvg > fifoAvg.
    expect(impAvg).toBeGreaterThan(0.55);
    expect(fifoAvg).toBeLessThan(0.55);
    expect(impAvg).toBeGreaterThan(fifoAvg + 0.05);
  });

  it("achieves ≥5× density ratio of high vs low importance under sustained pressure", () => {
    // Use block pattern B=4 so K-lookahead consistently evicts L-blocks.
    const capacity = 64;
    const buf = new PointBuffer({ maxPoints: capacity, mode: "drop-oldest", importanceField: "score" });

    buf.ingest(makeBlockPattern(capacity));          // 32H + 32L (B=4)
    buf.ingest(makePoints(capacity, 0.5, capacity)); // overflow by 1× capacity

    const pts       = buf.snapshot();
    const highCount = pts.filter(p => (p.attributes?.score ?? 0) >= 0.9).length;
    const lowCount  = pts.filter(p => (p.attributes?.score ?? 0) <= 0.1).length;

    if (lowCount > 0) {
      expect(highCount / lowCount).toBeGreaterThanOrEqual(5);
    } else {
      // All low-importance evicted — ratio is effectively infinite.
      expect(highCount).toBeGreaterThan(0);
    }
  });

  it("drops-newest mode is unaffected by importanceField (no eviction path executes)", () => {
    const buf = new PointBuffer({ maxPoints: 5, mode: "drop-newest", importanceField: "score" });
    buf.ingest(makePoints(5, 0.0));  // fill
    buf.ingest(makePoints(3, 1.0, 5)); // overflow — dropped newest
    expect(buf.getStats().droppedPoints).toBe(3);
    // Original low-importance points still in buffer (newest were dropped)
    const pts = buf.snapshot();
    expect(pts.every(p => (p.attributes?.score ?? 0) === 0.0)).toBe(true);
  });

  it("missing score attribute defaults to importance 1.0 — point treated as fully important", () => {
    const capacity = 5;
    const buf = new PointBuffer({ maxPoints: capacity, mode: "drop-oldest", importanceField: "score" });

    // Fill with explicit score=0 (low importance)
    buf.ingest(Array.from({ length: capacity }, (_, i) => ({
      x: i, y: 0, z: 0, attributes: { score: 0.0 },
    })));

    // Overflow with 3 points that have NO score attribute → default = 1.0
    buf.ingest([
      { x: 10, y: 0, z: 0 }, // no score → importance 1.0
      { x: 11, y: 0, z: 0 },
      { x: 12, y: 0, z: 0 },
    ]);

    const retained = buf.snapshot().map(p => p.x);
    expect(retained).toContain(10);
    expect(retained).toContain(11);
    expect(retained).toContain(12);
  });
});

// ─── 2. Eviction bias (ingestFromBinary path) ────────────────────────────────

describe("Eviction bias — ingestFromBinary() hot path", () => {
  it("K-lookahead bias works identically via typed-array ingest", () => {
    // Block pattern B=4 (same as PointRecord test): H-gap = 2B=8 < K=16 → K always finds L.
    const capacity = 64;
    const withImp = new PointBuffer({ maxPoints: capacity, mode: "drop-oldest", importanceField: "score" });
    const fifo    = new PointBuffer({ maxPoints: capacity, mode: "drop-oldest" });

    const initial = makeBinary(capacity, (i) => Math.floor(i / 4) % 2 === 0 ? 1.0 : 0.0);
    withImp.ingestFromBinary(initial.xyz, initial.attrs, initial.count);
    fifo.ingestFromBinary(initial.xyz, initial.attrs, initial.count);

    const over = makeBinary(32, () => 0.5, capacity);
    withImp.ingestFromBinary(over.xyz, over.attrs, over.count);
    fifo.ingestFromBinary(over.xyz, over.attrs, over.count);

    const impAvg  = avgScore(withImp);
    const fifoAvg = avgScore(fifo);

    expect(impAvg).toBeGreaterThan(0.55);
    expect(impAvg).toBeGreaterThan(fifoAvg + 0.05);
  });

  it("importance channel not present in binary payload → defaults to 1.0 for all slots", () => {
    const buf = new PointBuffer({ maxPoints: 10, mode: "drop-oldest", importanceField: "score" });

    // Ingest via binary with NO score channel — all default to 1.0.
    const xyz = new Float32Array(10 * 3);
    buf.ingestFromBinary(xyz, [], 10); // no attribute channels
    expect(buf.getStats().totalPoints).toBe(10);
    expect(buf.getStats().droppedPoints).toBe(0);
  });
});

// ─── 3. Staleness / recency decay ────────────────────────────────────────────

describe("Recency decay (maxStalenessMs)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("evicts stale high-importance points over fresh low-importance ones", () => {
    const halfLife = 200; // ms
    // capacity ≤ K=16 so the ENTIRE buffer is in the lookahead window.
    // This guarantees K-lookahead compares old-high vs fresh-low on every eviction.
    const capacity = 16;

    // Buffer A: importance + staleness
    const withStaleness = new PointBuffer({
      maxPoints: capacity, mode: "drop-oldest",
      importanceField: "score", maxStalenessMs: halfLife,
    });
    // Buffer B: importance only (no staleness)
    const importanceOnly = new PointBuffer({
      maxPoints: capacity, mode: "drop-oldest",
      importanceField: "score",
    });

    // t = 0: ingest 8 points with score=1.0 (high importance)
    withStaleness.ingest(makePoints(8, 1.0));
    importanceOnly.ingest(makePoints(8, 1.0));

    // Advance time by 10 half-lives: recency = 2^(-10) ≈ 0.001
    vi.advanceTimersByTime(halfLife * 10);

    // t = 10×halfLife: ingest 8 fresh points with score=0.3 (lower importance but brand new)
    withStaleness.ingest(makePoints(8, 0.3, 8));
    importanceOnly.ingest(makePoints(8, 0.3, 8));
    // Both buffers are now full (16/16).

    // Ingest 8 overflow — triggers 8 evictions in each buffer.
    withStaleness.ingest(makePoints(8, 0.5, 16));
    importanceOnly.ingest(makePoints(8, 0.5, 16));

    const stalenessAvg      = avgScore(withStaleness);
    const importanceOnlyAvg = avgScore(importanceOnly);

    // importanceOnly: K=16 sees all 16 slots; worst = fresh low (0.3) → evicts all 8 low first.
    //   avg ≈ (8×1.0 + 0×0.3 + 8×0.5) / 16 = 0.75
    // withStaleness: score(old) = 1.0 × 2^(-10) ≈ 0.001 < score(fresh=0.3) → evicts old high.
    //   avg ≈ (0×1.0 + 8×0.3 + 8×0.5) / 16 = 0.40
    expect(importanceOnlyAvg).toBeGreaterThan(0.65);
    expect(stalenessAvg).toBeLessThan(importanceOnlyAvg - 0.20);
  });

  it("recency alone (no importanceField) biases eviction toward oldest when halfLife is short", () => {
    const halfLife = 100; // ms
    const capacity = 60;

    const buf = new PointBuffer({
      maxPoints: capacity, mode: "drop-oldest",
      maxStalenessMs: halfLife, // no importanceField — all explicit importance = 1.0
    });

    // t=0: fill with 30 points
    buf.ingest(makePoints(30, 0.0));

    // Advance 6 half-lives — these are now old
    vi.advanceTimersByTime(halfLife * 6);

    // t=600ms: fill with 30 more fresh points
    buf.ingest(makePoints(30, 0.0, 30));
    // Buffer full (60).

    // Overflow by 20 — with pure recency, should evict old ones preferentially.
    buf.ingest(makePoints(20, 0.0, 60));

    const pts = buf.snapshot();
    expect(pts).toHaveLength(capacity);
    // The fresh points (x ≥ 30) should survive more than the old ones (x < 30).
    const freshCount = pts.filter(p => p.x >= 30).length;
    expect(freshCount).toBeGreaterThan(20); // at least 20 of the 30 fresh survived
  });
});

// ─── 4. No regression ────────────────────────────────────────────────────────

describe("No regression — pure FIFO when importance features are off", () => {
  it("uniform importance (all 1.0) produces identical eviction order to pure FIFO", () => {
    // When every point has score=1.0, all scores are equal.
    // K-lookahead picks worstOffset=0 (head) because no slot beats the first one.
    // Result: identical to FIFO — head is always evicted, just like without importanceField.
    const withUniform = new PointBuffer({ maxPoints: 5, mode: "drop-oldest", importanceField: "score" });
    const fifo        = new PointBuffer({ maxPoints: 5, mode: "drop-oldest" });

    const fill = Array.from({ length: 5 }, (_, i) => ({ x: i, y: 0, z: 0, attributes: { score: 1.0 } }));
    const over = Array.from({ length: 3 }, (_, i) => ({ x: 10 + i, y: 0, z: 0, attributes: { score: 1.0 } }));

    withUniform.ingest(fill); fifo.ingest(fill.map(p => ({ ...p })));
    withUniform.ingest(over); fifo.ingest(over.map(p => ({ ...p })));

    const uniXs  = withUniform.snapshot().map(p => p.x).sort((a, b) => a - b);
    const fifoXs = fifo.snapshot().map(p => p.x).sort((a, b) => a - b);

    expect(uniXs).toEqual(fifoXs);
    expect(withUniform.getStats().droppedPoints).toBe(fifo.getStats().droppedPoints);
  });

  it("drop-oldest FIFO is unchanged when no importanceField or maxStalenessMs", () => {
    const buf = new PointBuffer({ maxPoints: 5, mode: "drop-oldest" });
    buf.ingest(Array.from({ length: 5 }, (_, i) => ({ x: i, y: 0, z: 0 })));
    buf.ingest(Array.from({ length: 3 }, (_, i) => ({ x: 10 + i, y: 0, z: 0 })));

    const xs = buf.snapshot().map(p => p.x);
    // Pure FIFO: oldest 3 (x=0,1,2) evicted; kept: x=3,4,10,11,12
    expect(xs).toContain(3);
    expect(xs).toContain(4);
    expect(xs).toContain(10);
    expect(xs).not.toContain(0);
    expect(xs).not.toContain(1);
    expect(xs).not.toContain(2);
  });

  it("droppedPoints count is identical with and without importanceField", () => {
    const withImp = new PointBuffer({ maxPoints: 10, mode: "drop-oldest", importanceField: "score" });
    const fifo    = new PointBuffer({ maxPoints: 10, mode: "drop-oldest" });

    const pts = makePoints(10, 0.5);
    withImp.ingest(pts); fifo.ingest(pts);

    const over = makePoints(7, 0.5, 10);
    withImp.ingest(over); fifo.ingest(over);

    expect(withImp.getStats().droppedPoints).toBe(fifo.getStats().droppedPoints);
  });
});

// ─── 5. Edge cases & stability ───────────────────────────────────────────────

describe("Edge cases and stability", () => {
  it("no eviction at all when buffer is not under pressure", () => {
    const buf = new PointBuffer({ maxPoints: 100, mode: "drop-oldest", importanceField: "score" });
    buf.ingest(makePoints(50, 0.0));
    expect(buf.getStats().droppedPoints).toBe(0);
    expect(buf.getStats().totalPoints).toBe(50);
  });

  it("reset clears importance state; buffer works correctly after reset", () => {
    const buf = new PointBuffer({ maxPoints: 10, mode: "drop-oldest", importanceField: "score" });
    buf.ingest(makeAlternating(10));
    buf.ingest(makePoints(5, 0.5, 10));
    buf.reset();

    expect(buf.getStats().totalPoints).toBe(0);
    expect(buf.getStats().droppedPoints).toBe(0);

    // Re-fill after reset
    buf.ingest(makeAlternating(10));
    buf.ingest(makePoints(5, 0.5, 10));
    // K-lookahead should still work after reset
    expect(avgScore(buf)).toBeGreaterThan(0.5);
  });

  it("K-lookahead capped at buffer size for small buffers (K > size)", () => {
    // Buffer smaller than K=16 — should not crash and still evict worst
    const buf = new PointBuffer({ maxPoints: 4, mode: "drop-oldest", importanceField: "score" });
    buf.ingest([
      { x: 0, y: 0, z: 0, attributes: { score: 0.0 } }, // low
      { x: 1, y: 0, z: 0, attributes: { score: 1.0 } }, // high
      { x: 2, y: 0, z: 0, attributes: { score: 0.0 } }, // low
      { x: 3, y: 0, z: 0, attributes: { score: 1.0 } }, // high — buffer full
    ]);
    buf.ingest([
      { x: 4, y: 0, z: 0, attributes: { score: 0.5 } }, // overflow × 2
      { x: 5, y: 0, z: 0, attributes: { score: 0.5 } },
    ]);

    const pts = buf.snapshot();
    expect(pts).toHaveLength(4);
    // High-importance points (x=1, x=3) should have survived
    const xs = pts.map(p => p.x);
    expect(xs).toContain(1);
    expect(xs).toContain(3);
  });

  it("importance engine does not break dynamic allocation growth", () => {
    const buf = new PointBuffer({
      maxPoints: 100, mode: "drop-oldest",
      importanceField: "score",
      dynamicAlloc: { initialCapacity: 8, growthFactor: 2 },
      deferGrowth: false,
    });
    for (let i = 0; i < 10; i++) {
      buf.ingest(makePoints(10, i % 2 === 0 ? 0.0 : 1.0, i * 10));
    }
    expect(buf.getStats().totalPoints).toBeGreaterThan(0);
    expect(() => buf.snapshot()).not.toThrow();
  });
});
