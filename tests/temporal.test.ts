/**
 * M12 — Temporal Analytics tests.
 *
 * Verifies:
 *   1. getTemporalStats: correct oldest/newest ages and total count.
 *   2. getTemporalStats: windowedCount respects timeWindowMs.
 *   3. copyToTypedArrays: timeWindowCutoffRelEpoch filters out old points.
 *   4. epochMs getter is stable and positive.
 *   5. copyTimestampsForGPU: emits correct relative timestamps for active slots.
 *   6. Empty buffer returns zero stats.
 *   7. Time window = 0 → all points counted (no filter).
 */

import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { PointBuffer } from "../src/core/backpressure";
import type { PackedAttributeChannel } from "../src/core/types";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeBinaryChunk(count: number): {
  xyz: Float32Array;
  attributes: PackedAttributeChannel[];
} {
  const xyz = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    xyz[i * 3] = i; xyz[i * 3 + 1] = 0; xyz[i * 3 + 2] = 0;
  }
  const values  = new Float32Array(count).fill(0.5);
  const present = new Uint8Array(count).fill(1);
  return { xyz, attributes: [{ key: "v", values, present }] };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("M12 — Temporal Analytics", () => {
  let realDateNow: () => number;
  const T0 = 1_700_000_000_000; // arbitrary epoch anchor

  beforeEach(() => {
    realDateNow = Date.now;
    Date.now = vi.fn(() => T0);
  });

  afterEach(() => {
    Date.now = realDateNow;
    vi.restoreAllMocks();
  });

  it("epochMs getter is positive and reflects construction time", () => {
    const buf = new PointBuffer({ maxPoints: 10, mode: "drop-oldest" });
    expect(buf.epochMs).toBe(T0);
    expect(buf.epochMs).toBeGreaterThan(0);
  });

  it("empty buffer returns all-zero TemporalStats", () => {
    const buf = new PointBuffer({ maxPoints: 10, mode: "drop-oldest" });
    const stats = buf.getTemporalStats(T0);
    expect(stats.oldestPointAgeMs).toBe(0);
    expect(stats.newestPointAgeMs).toBe(0);
    expect(stats.windowedCount).toBe(0);
    expect(stats.totalCount).toBe(0);
  });

  it("getTemporalStats reflects correct ages after ingest at known times", () => {
    const buf = new PointBuffer({ maxPoints: 10, mode: "drop-oldest" });

    // Ingest first batch at T0
    const { xyz: xyz1, attributes: attr1 } = makeBinaryChunk(3);
    buf.ingestFromBinary(xyz1, attr1, 3);

    // Advance clock by 2000 ms, ingest second batch
    (Date.now as ReturnType<typeof vi.fn>).mockReturnValue(T0 + 2000);
    const { xyz: xyz2, attributes: attr2 } = makeBinaryChunk(2);
    buf.ingestFromBinary(xyz2, attr2, 2);

    // Query at T0 + 3000
    const stats = buf.getTemporalStats(T0 + 3000);
    expect(stats.totalCount).toBe(5);
    // Oldest points were ingested at T0, so age ≈ 3000 ms
    expect(stats.oldestPointAgeMs).toBeCloseTo(3000, -1);
    // Newest points were ingested at T0+2000, so age ≈ 1000 ms
    expect(stats.newestPointAgeMs).toBeCloseTo(1000, -1);
  });

  it("windowedCount = totalCount when no time window set", () => {
    const buf = new PointBuffer({ maxPoints: 10, mode: "drop-oldest" });
    const { xyz, attributes } = makeBinaryChunk(5);
    buf.ingestFromBinary(xyz, attributes, 5);
    const stats = buf.getTemporalStats(T0 + 1000);
    expect(stats.windowedCount).toBe(stats.totalCount);
  });

  it("windowedCount filters by timeWindowMs", () => {
    const buf = new PointBuffer({ maxPoints: 20, mode: "drop-oldest" });

    // Ingest 5 points at T0
    const { xyz: xyz1, attributes: attr1 } = makeBinaryChunk(5);
    buf.ingestFromBinary(xyz1, attr1, 5);

    // Advance 5000 ms, ingest 3 more points
    (Date.now as ReturnType<typeof vi.fn>).mockReturnValue(T0 + 5000);
    const { xyz: xyz2, attributes: attr2 } = makeBinaryChunk(3);
    buf.ingestFromBinary(xyz2, attr2, 3);

    // Query with timeWindowMs = 2000: only the recent 3 points qualify
    const stats = buf.getTemporalStats(T0 + 6000, 2000);
    expect(stats.totalCount).toBe(8);
    expect(stats.windowedCount).toBe(3);
  });

  it("copyToTypedArrays respects timeWindowCutoffRelEpoch", () => {
    const buf = new PointBuffer({ maxPoints: 20, mode: "drop-oldest" });

    // Ingest 4 old points at T0
    const { xyz: xyz1, attributes: attr1 } = makeBinaryChunk(4);
    buf.ingestFromBinary(xyz1, attr1, 4);

    // Advance 5000 ms, ingest 3 fresh points
    (Date.now as ReturnType<typeof vi.fn>).mockReturnValue(T0 + 5000);
    const { xyz: xyz2, attributes: attr2 } = makeBinaryChunk(3);
    buf.ingestFromBinary(xyz2, attr2, 3);

    // Now at T0+6000, window = 2000 ms → cutoff = T0+4000 relative to epoch = 4000
    const nowRel = 6000; // T0+6000 - T0 = 6000
    const cutoff = nowRel - 2000; // = 4000

    const positions = new Float32Array(20 * 3);
    const colors    = new Float32Array(20 * 3);
    const n = buf.copyToTypedArrays(positions, colors, 1, undefined, undefined, undefined, false, cutoff);

    // Only the 3 fresh points (ingested at rel=5000 ≥ cutoff=4000) should render
    expect(n).toBe(3);
  });

  it("copyTimestampsForGPU emits one timestamp per active slot", () => {
    const buf = new PointBuffer({ maxPoints: 10, mode: "drop-oldest" });

    const { xyz, attributes } = makeBinaryChunk(4);
    buf.ingestFromBinary(xyz, attributes, 4);

    const tsOut = new Float32Array(10);
    buf.copyTimestampsForGPU(tsOut);

    // All 4 slots were ingested at T0 → relative = 0
    for (let i = 0; i < 4; i++) {
      expect(tsOut[i]).toBeCloseTo(0, 0);
    }
    // Remaining slots untouched (still 0)
    expect(tsOut[4]).toBe(0);
  });

  it("copyTimestampsForGPU reflects different ingest times across batches", () => {
    const buf = new PointBuffer({ maxPoints: 10, mode: "drop-oldest" });

    const { xyz: xyz1, attributes: attr1 } = makeBinaryChunk(2);
    buf.ingestFromBinary(xyz1, attr1, 2); // ts ≈ 0

    (Date.now as ReturnType<typeof vi.fn>).mockReturnValue(T0 + 3000);
    const { xyz: xyz2, attributes: attr2 } = makeBinaryChunk(2);
    buf.ingestFromBinary(xyz2, attr2, 2); // ts ≈ 3000

    const tsOut = new Float32Array(10);
    buf.copyTimestampsForGPU(tsOut);

    // Slots 0–1: ingested at rel=0
    expect(tsOut[0]).toBeCloseTo(0, 0);
    expect(tsOut[1]).toBeCloseTo(0, 0);
    // Slots 2–3: ingested at rel=3000
    expect(tsOut[2]).toBeCloseTo(3000, 0);
    expect(tsOut[3]).toBeCloseTo(3000, 0);
  });
});
