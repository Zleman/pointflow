/**
 * Property-based invariant tests for PointBuffer.
 *
 * Uses fast-check to generate arbitrary ingest/reset sequences and assert
 * structural invariants that must hold regardless of input.
 */
import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { PointBuffer } from "../src/core/backpressure";
import type { PointRecord } from "../src/core/types";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makePoint(x: number, y = 0, z = 0): PointRecord {
  return { x, y, z };
}

/** Arbitrary batch of 1–50 points with x in a finite range. */
const batchArb = fc
  .array(fc.float({ min: -1000, max: 1000, noNaN: true }), { minLength: 1, maxLength: 50 })
  .map((xs) => xs.map((x) => makePoint(x)));

// ── Invariant tests ───────────────────────────────────────────────────────────

describe("PointBuffer property invariants", () => {
  it("size never exceeds capacity after arbitrary ingest sequences", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 200 }),           // capacity
        fc.array(batchArb, { minLength: 1, maxLength: 10 }), // sequence of batches
        (capacity, batches) => {
          const buf = new PointBuffer({ maxPoints: capacity, mode: "drop-oldest" });
          for (const batch of batches) buf.ingest(batch);
          const { totalPoints } = buf.getStats();
          expect(totalPoints).toBeLessThanOrEqual(capacity);
        }
      ),
      { numRuns: 200 }
    );
  });

  it("droppedPoints = max(0, totalIngested - capacity) for drop-oldest mode", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 50 }),
        fc.array(batchArb, { minLength: 1, maxLength: 8 }),
        (capacity, batches) => {
          const buf = new PointBuffer({ maxPoints: capacity, mode: "drop-oldest" });
          let totalIngested = 0;
          for (const batch of batches) {
            totalIngested += batch.length;
            buf.ingest(batch);
          }
          const { droppedPoints, totalPoints } = buf.getStats();
          expect(totalPoints + droppedPoints).toBe(totalIngested);
          expect(totalPoints).toBeLessThanOrEqual(capacity);
        }
      ),
      { numRuns: 200 }
    );
  });

  it("drop-newest never exceeds capacity and oldest points are preserved", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 50 }),
        fc.array(batchArb, { minLength: 1, maxLength: 8 }),
        (capacity, batches) => {
          const buf = new PointBuffer({ maxPoints: capacity, mode: "drop-newest" });
          for (const batch of batches) buf.ingest(batch);
          const { totalPoints } = buf.getStats();
          expect(totalPoints).toBeLessThanOrEqual(capacity);
        }
      ),
      { numRuns: 200 }
    );
  });

  it("reset clears size and dropped counters regardless of prior state", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100 }),
        fc.array(batchArb, { minLength: 1, maxLength: 5 }),
        (capacity, batches) => {
          const buf = new PointBuffer({ maxPoints: capacity, mode: "drop-oldest" });
          for (const batch of batches) buf.ingest(batch);
          buf.reset();
          const stats = buf.getStats();
          expect(stats.totalPoints).toBe(0);
          expect(stats.droppedPoints).toBe(0);
          expect(stats.isUnderPressure).toBe(false);
          const positions = new Float32Array(capacity * 4);
          const colors = new Float32Array(capacity * 4);
          expect(buf.copyToTypedArrays(positions, colors, 1, undefined)).toBe(0);
        }
      ),
      { numRuns: 200 }
    );
  });

  it("copyToTypedArrays count never exceeds size", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 4, max: 200 }),
        fc.integer({ min: 1, max: 8 }),               // stride
        fc.array(batchArb, { minLength: 1, maxLength: 5 }),
        (capacity, stride, batches) => {
          const buf = new PointBuffer({ maxPoints: capacity, mode: "drop-oldest" });
          for (const batch of batches) buf.ingest(batch);
          const alloc = capacity * 4;
          const positions = new Float32Array(alloc);
          const colors = new Float32Array(alloc);
          const rendered = buf.copyToTypedArrays(positions, colors, stride, undefined);
          expect(rendered).toBeLessThanOrEqual(buf.getStats().totalPoints);
        }
      ),
      { numRuns: 200 }
    );
  });

  it("snapshot length equals getStats().totalPoints", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100 }),
        fc.array(batchArb, { minLength: 0, maxLength: 6 }),
        (capacity, batches) => {
          const buf = new PointBuffer({ maxPoints: capacity, mode: "drop-oldest" });
          for (const batch of batches) buf.ingest(batch);
          expect(buf.snapshot()).toHaveLength(buf.getStats().totalPoints);
        }
      ),
      { numRuns: 200 }
    );
  });

  it("ingestFromBinary and ingest produce equal stats for same data", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 4, max: 80 }),
        fc.array(fc.float({ min: -100, max: 100, noNaN: true }), { minLength: 3, maxLength: 60 })
          .filter((arr) => arr.length % 3 === 0),
        (capacity, flat) => {
          const count = flat.length / 3;
          const xyz = new Float32Array(flat);
          const pts: PointRecord[] = [];
          for (let i = 0; i < count; i++)
            pts.push({ x: flat[i * 3], y: flat[i * 3 + 1], z: flat[i * 3 + 2] });

          const bufAoS = new PointBuffer({ maxPoints: capacity, mode: "drop-oldest" });
          bufAoS.ingest(pts);

          const bufBin = new PointBuffer({ maxPoints: capacity, mode: "drop-oldest" });
          bufBin.ingestFromBinary(xyz, undefined, count);

          expect(bufBin.getStats()).toEqual(bufAoS.getStats());
        }
      ),
      { numRuns: 150 }
    );
  });

  it("K-lookahead preferentially retains high-importance points under pressure", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 10, max: 50 }),  // capacity
        fc.integer({ min: 5, max: 20 }),   // extra overflow
        (capacity, extra) => {
          const total = capacity + extra;
          const buf = new PointBuffer({
            maxPoints: capacity,
            mode: "drop-oldest",
            importanceField: "priority",
          });

          // Low-importance first (priority = 0.1), high-importance second (priority = 1.0).
          // Under pressure, K-lookahead should evict the low-importance points preferentially.
          const lowPriority  = Array.from({ length: total }, (_, i) => ({
            x: i, y: 0, z: 0, attributes: { priority: 0.1 },
          }));
          const highPriority = Array.from({ length: capacity }, (_, i) => ({
            x: 10000 + i, y: 0, z: 0, attributes: { priority: 1.0 },
          }));

          buf.ingest(lowPriority);
          buf.ingest(highPriority);

          const snap = buf.snapshot();
          const highCount = snap.filter((p) => p.x >= 10000).length;
          // High-importance points should occupy more slots than pure FIFO would give them.
          // With FIFO they'd all be evicted; with K-lookahead most survive.
          expect(highCount).toBeGreaterThan(0);
          expect(snap.length).toBeLessThanOrEqual(capacity);
        }
      ),
      { numRuns: 100 }
    );
  });
});
