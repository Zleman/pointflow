import type { BackpressurePolicy, BufferStats, DensityWeight, PackedAttributeChannel, PointRecord, TemporalStats } from "./types";
import { writeScalarToRgbBuffer, lasClassToU32 } from "./color-map";
import { cellKey, cellCenter } from "./spatial-index";
import { importanceScore } from "./importance-engine";
import { pickNearestPoint } from "./point-buffer-queries";
import type { PickStrategy } from "./types";

/**
 * Ring-buffer backed point store with SoA typed-array storage.
 *
 * Ingest:  O(chunk.length)    — pointer-advance, no array allocation.
 * Snapshot: O(size)           — kept for external consumers of usePointFlow.
 * copyToTypedArrays: O(size/stride) — hot path for PointCloudScene; far-camera
 *   LOD levels are genuinely cheaper because stride reduces iteration count.
 * Reset:   O(capacity)        — clears slot stamps so GC can collect old objects.
 *
 * File size exception (~1100 lines): all methods share the same 15 private SoA typed arrays.
 * TypeScript has no partial-class syntax; splitting would require a state-struct pattern that
 * adds indirection without clarity. Pure algorithm extraction is handled by spatial-index.ts,
 * importance-engine.ts, and point-buffer-queries.ts. What remains is tightly coupled I/O.
 */
export class PointBuffer {
  private readonly policy: BackpressurePolicy;
  // `capacity` is the current allocated size. In pre-alloc mode it equals
  // policy.maxPoints forever. In dynamic mode it grows toward policy.maxPoints.
  private capacity: number;
  private items: (PointRecord | undefined)[];
  private xs: Float32Array;
  private ys: Float32Array;
  private zs: Float32Array;
  private attrVals: Float32Array;
  private readonly packedAttrValuesByKey = new Map<string, Float32Array>();
  private readonly packedAttrPresenceByKey = new Map<string, Uint8Array>();
  private trackedAttr: string | undefined = undefined;
  private head = 0; // index of oldest item
  private size = 0; // number of occupied slots
  private droppedPoints = 0;

  private slotWriteSeq: Float64Array;
  private readonly channelWriteSeq = new Map<string, Float64Array>();
  private writeSeqCounter = 1.0; // global monotonic counter; 0 is reserved for "unwritten"

  private attrRangeMin = Infinity;
  private attrRangeMax = -Infinity;
  private attrRangeDirty = true;
  private _rgbScale = 255;

  // Dynamic allocation bookkeeping (only used when policy.dynamicAlloc is set)
  private readonly _isDynamic: boolean;
  private readonly _growthFactor: number;
  private readonly _deferGrowth: boolean;
  private _growthPending = false;

  private readonly _maintainSpatialIndex: boolean;
  private slotToCellKey: number[];
  private readonly cellSlots: Map<number, Set<number>>;

  // Unified Importance Engine
  private importanceBuffer: Float32Array;   // raw importance value per slot (default 1.0)
  private slotTimestampMs: Float32Array;    // write time per slot, epoch-relative (ms, Float32)
  private _importanceField: string | undefined;   // mutable — supports runtime "auto" resolution
  private readonly _recencyLambda: number; // = ln(2) / maxStalenessMs, or 0
  private _useKLookahead: boolean;          // mutable — enabled when setImportanceField() resolves "auto"
  private readonly _epochMs: number;        // Date.now() at construction
  private readonly _densityWeight: DensityWeight;
  private readonly _classificationWeights: Record<number, number> | undefined;
  private readonly _classificationField: string;

  constructor(policy: BackpressurePolicy) {
    if (policy.maxPoints < 1) {
      throw new Error("maxPoints must be greater than 0");
    }
    this.policy = policy;
    this._isDynamic = policy.dynamicAlloc !== undefined;
    this._deferGrowth = this._isDynamic && (policy.deferGrowth ?? true);
    const requestedGrowth = policy.dynamicAlloc?.growthFactor;
    if (this._isDynamic && requestedGrowth !== undefined && requestedGrowth <= 1) {
      console.warn("PointBuffer: dynamicAlloc.growthFactor must be > 1, got", requestedGrowth, "- using 2");
    }
    this._growthFactor = (requestedGrowth !== undefined && requestedGrowth > 1)
      ? requestedGrowth
      : 2;

    if (this._isDynamic) {
      const initial = policy.dynamicAlloc!.initialCapacity;
      const defaultInitial = Math.min(1024, policy.maxPoints);
      const validated = (initial !== undefined && initial >= 1 && initial <= policy.maxPoints)
        ? initial
        : defaultInitial;
      this.capacity = validated;
    } else {
      this.capacity = policy.maxPoints;
    }

    this.items = new Array<PointRecord | undefined>(this.capacity);
    this.xs = new Float32Array(this.capacity);
    this.ys = new Float32Array(this.capacity);
    this.zs = new Float32Array(this.capacity);
    this.attrVals = new Float32Array(this.capacity);
    this.slotWriteSeq = new Float64Array(this.capacity);
    this._maintainSpatialIndex = policy.spatialCulling !== false || (policy.densityWeight !== undefined && policy.densityWeight !== "none");
    this.slotToCellKey = this._maintainSpatialIndex ? new Array<number>(this.capacity) : [];
    this.cellSlots = new Map<number, Set<number>>();
    this._importanceField = policy.importanceField;
    this._recencyLambda = (policy.maxStalenessMs && policy.maxStalenessMs > 0)
      ? Math.LN2 / policy.maxStalenessMs
      : 0;
    this._useKLookahead = policy.importanceField !== undefined
      || (policy.maxStalenessMs !== undefined && policy.maxStalenessMs > 0)
      || policy.classificationWeights !== undefined
      || (policy.densityWeight !== undefined && policy.densityWeight !== "none");
    this._densityWeight = policy.densityWeight ?? "none";
    this._classificationWeights = policy.classificationWeights;
    this._classificationField   = policy.classificationField ?? "classification";
    this._epochMs = Date.now();
    this.importanceBuffer = new Float32Array(this.capacity).fill(1);
    this.slotTimestampMs  = new Float32Array(this.capacity);
  }

  private _addSlotToSpatialIndex(slot: number): void {
    if (!this._maintainSpatialIndex) return;
    const key = cellKey(this.xs[slot], this.ys[slot], this.zs[slot]);
    this.slotToCellKey[slot] = key;
    let set = this.cellSlots.get(key);
    if (set === undefined) {
      set = new Set<number>();
      this.cellSlots.set(key, set);
    }
    set.add(slot);
  }

  private _removeSlotFromSpatialIndex(slot: number): void {
    if (!this._maintainSpatialIndex) return;
    const key = this.slotToCellKey[slot];
    const set = this.cellSlots.get(key);
    if (set !== undefined) {
      set.delete(slot);
      if (set.size === 0) this.cellSlots.delete(key);
    }
  }

  /**
   * Grow internal arrays by _growthFactor, capped at policy.maxPoints.
   * Unrolls the ring buffer so data is contiguous from index 0 after growth.
   * Only called when _isDynamic is true and capacity < policy.maxPoints.
   */
  private _grow(): void {
    const maxCap = this.policy.maxPoints;
    const newCap = Math.min(Math.floor(this.capacity * this._growthFactor), maxCap);
    if (newCap <= this.capacity) return;

    const oldCap = this.capacity;
    const sz = this.size;

    const newXs = new Float32Array(newCap);
    const newYs = new Float32Array(newCap);
    const newZs = new Float32Array(newCap);
    const newAttrVals = new Float32Array(newCap);
    const newSlotWriteSeq = new Float64Array(newCap);
    const newItems = new Array<PointRecord | undefined>(newCap);

    const newImportance   = new Float32Array(newCap).fill(1);
    const newTimestamps   = new Float32Array(newCap);

    // Unroll ring (logical order → contiguous from index 0)
    for (let i = 0; i < sz; i++) {
      const src = (this.head + i) % oldCap;
      newXs[i] = this.xs[src];
      newYs[i] = this.ys[src];
      newZs[i] = this.zs[src];
      newAttrVals[i] = this.attrVals[src];
      newSlotWriteSeq[i] = this.slotWriteSeq[src];
      newItems[i] = this.items[src];
      newImportance[i]  = this.importanceBuffer[src];
      newTimestamps[i]  = this.slotTimestampMs[src];
    }

    // Grow packed attribute stores
    for (const [key, oldValues] of this.packedAttrValuesByKey) {
      const newValues = new Float32Array(newCap);
      const oldPresence = this.packedAttrPresenceByKey.get(key)!;
      const newPresence = new Uint8Array(newCap);
      for (let i = 0; i < sz; i++) {
        const src = (this.head + i) % oldCap;
        newValues[i] = oldValues[src];
        newPresence[i] = oldPresence[src];
      }
      this.packedAttrValuesByKey.set(key, newValues);
      this.packedAttrPresenceByKey.set(key, newPresence);
    }

    // Grow channel write sequences
    for (const [key, oldSeq] of this.channelWriteSeq) {
      const newSeq = new Float64Array(newCap);
      for (let i = 0; i < sz; i++) {
        const src = (this.head + i) % oldCap;
        newSeq[i] = oldSeq[src];
      }
      this.channelWriteSeq.set(key, newSeq);
    }

    this.xs = newXs;
    this.ys = newYs;
    this.zs = newZs;
    this.attrVals = newAttrVals;
    this.slotWriteSeq = newSlotWriteSeq;
    this.items = newItems;
    this.importanceBuffer = newImportance;
    this.slotTimestampMs  = newTimestamps;
    this.head = 0;
    this.capacity = newCap;
    if (this._maintainSpatialIndex) {
      this.slotToCellKey = new Array<number>(this.capacity);
      this.cellSlots.clear();
      for (let i = 0; i < sz; i++) this._addSlotToSpatialIndex(i);
    }
  }

  /**
   * Schedule _grow() off the ingest critical path.
   * Uses requestAnimationFrame in browser environments and a resolved Promise
   * (microtask) in Node.js / test environments. Calling while a grow is already
   * pending is a no-op.
   */
  private _scheduleGrow(): void {
    if (this._growthPending) return;
    this._growthPending = true;
    const doGrow = () => {
      this._growthPending = false;
      if (this._isDynamic && this.capacity < this.policy.maxPoints) {
        this._grow();
      }
    };
    if (typeof requestAnimationFrame !== "undefined") {
      requestAnimationFrame(doGrow);
    } else {
      Promise.resolve().then(doGrow);
    }
  }

  /** Returns the current allocated capacity of the buffer. */
  currentCapacity(): number {
    return this.capacity;
  }

  private ensurePackedAttributeStore(key: string): { values: Float32Array; present: Uint8Array } {
    let values = this.packedAttrValuesByKey.get(key);
    let present = this.packedAttrPresenceByKey.get(key);
    if (values === undefined || present === undefined) {
      values = new Float32Array(this.capacity);
      present = new Uint8Array(this.capacity);
      this.packedAttrValuesByKey.set(key, values);
      this.packedAttrPresenceByKey.set(key, present);
    }
    return { values, present };
  }

  /** Returns (creating if needed) the channelWriteSeq array for a key. */
  private ensureChannelWriteSeq(key: string): Float64Array {
    let seq = this.channelWriteSeq.get(key);
    if (seq === undefined) {
      seq = new Float64Array(this.capacity); // all 0 = stale vs slotWriteSeq
      this.channelWriteSeq.set(key, seq);
    }
    return seq;
  }

  private synthesizePackedAttributes(slot: number): Record<string, number> | undefined {
    const slotSeq = this.slotWriteSeq[slot];
    if (slotSeq === 0) return undefined; // slot never binary-written
    let attributes: Record<string, number> | undefined;
    for (const [key, chanSeqs] of this.channelWriteSeq.entries()) {
      if (chanSeqs[slot] !== slotSeq) continue;
      const present = this.packedAttrPresenceByKey.get(key);
      if (!present || present[slot] !== 1) continue; // channel absent for this point
      if (attributes === undefined) {
        attributes = {};
      }
      attributes[key] = this.packedAttrValuesByKey.get(key)![slot];
    }
    return attributes;
  }

  private writeSlot(slot: number, point: PointRecord): void {
    this.items[slot] = point;
    this.xs[slot] = point.x;
    this.ys[slot] = point.y;
    this.zs[slot] = point.z;
    if (this.trackedAttr !== undefined) {
      this.attrVals[slot] = point.attributes?.[this.trackedAttr] ?? 0;
    }
    this.slotWriteSeq[slot] = this.writeSeqCounter++;
    this.importanceBuffer[slot] = this._importanceField !== undefined
      ? (point.attributes?.[this._importanceField] ?? 1.0)
      : 1.0;
    // Classification weight override
    if (this._classificationWeights !== undefined) {
      const cv = Math.round(point.attributes?.[this._classificationField] ?? -1);
      const w  = this._classificationWeights[cv];
      if (w !== undefined) this.importanceBuffer[slot] = w;
    }
    this.slotTimestampMs[slot] = Date.now() - this._epochMs;
  }

  /** Update attrRangeMin/Max when adding a point to a free slot (no eviction). */
  private rangeExpandAdd(val: number): void {
    if (val < this.attrRangeMin) this.attrRangeMin = val;
    if (val > this.attrRangeMax) this.attrRangeMax = val;
  }

  /**
   * Update range when a slot is overwritten (drop-oldest).
   * oldVal is the attrVals value for the slot being evicted.
   * newVal is the value about to be written.
   */
  private rangeUpdateOnOverwrite(oldVal: number, newVal: number): void {
    if (oldVal === this.attrRangeMin || oldVal === this.attrRangeMax) {
      this.attrRangeDirty = true;
    }
    if (newVal < this.attrRangeMin) this.attrRangeMin = newVal;
    if (newVal > this.attrRangeMax) this.attrRangeMax = newVal;
  }

  /** Composite importance × recency × density score for a slot. */
  private _score(slot: number, nowRelEpoch: number): number {
    const density = this._densityWeight !== "none"
      ? (this.cellSlots.get(this.slotToCellKey[slot])?.size ?? 1)
      : 1;
    return importanceScore(
      this.importanceBuffer[slot],
      this.slotTimestampMs[slot],
      nowRelEpoch,
      this._recencyLambda,
      this._densityWeight,
      density,
    );
  }

  /** Swap all SoA data between two ring slots (used by K-lookahead). */
  private _swapSlots(a: number, b: number): void {
    let tmp: number;
    tmp = this.xs[a];              this.xs[a] = this.xs[b];              this.xs[b] = tmp;
    tmp = this.ys[a];              this.ys[a] = this.ys[b];              this.ys[b] = tmp;
    tmp = this.zs[a];              this.zs[a] = this.zs[b];              this.zs[b] = tmp;
    tmp = this.attrVals[a];        this.attrVals[a] = this.attrVals[b];  this.attrVals[b] = tmp;
    tmp = this.importanceBuffer[a]; this.importanceBuffer[a] = this.importanceBuffer[b]; this.importanceBuffer[b] = tmp;
    tmp = this.slotTimestampMs[a];  this.slotTimestampMs[a]  = this.slotTimestampMs[b];  this.slotTimestampMs[b]  = tmp;
    const seqTmp = this.slotWriteSeq[a]; this.slotWriteSeq[a] = this.slotWriteSeq[b]; this.slotWriteSeq[b] = seqTmp;
    const itemTmp = this.items[a];       this.items[a] = this.items[b];                  this.items[b] = itemTmp;
    for (const values of this.packedAttrValuesByKey.values()) {
      tmp = values[a]; values[a] = values[b]; values[b] = tmp;
    }
    for (const presence of this.packedAttrPresenceByKey.values()) {
      tmp = presence[a]; presence[a] = presence[b]; presence[b] = tmp;
    }
    for (const seqs of this.channelWriteSeq.values()) {
      const st = seqs[a]; seqs[a] = seqs[b]; seqs[b] = st;
    }
  }

  /**
  * Find the K-lookahead worst slot and swap it to head.
   * Called immediately before drop-oldest eviction in both ingest paths.
   * K=16 — stays O(K) not O(n).
   */
  private _kLookaheadSwapToHead(nowRelEpoch: number): void {
    const K = 16;
    const lookK = Math.min(K, this.size);
    let worstOffset = 0;
    let worstScore = this._score(this.head, nowRelEpoch);
    for (let k = 1; k < lookK; k++) {
      const s = (this.head + k) % this.capacity;
      const sc = this._score(s, nowRelEpoch);
      if (sc < worstScore) {
        worstScore = sc;
        worstOffset = k;
      }
    }
    if (worstOffset !== 0) {
      const worstSlot = (this.head + worstOffset) % this.capacity;
      // Remove worstSlot from spatial index (it keeps old head data after swap)
      this._removeSlotFromSpatialIndex(worstSlot);
      this._swapSlots(this.head, worstSlot);
      // Re-add worstSlot with old head's xyz (which is now there after swap)
      this._addSlotToSpatialIndex(worstSlot);
    }
  }

  ingest(chunk: PointRecord[]): BufferStats {
    if (chunk.length === 0) {
      return this.getStats();
    }

    // Dynamic: grow to fit incoming points (deferred off-path by default)
    if (this._isDynamic && this.size + chunk.length > this.capacity && this.capacity < this.policy.maxPoints) {
      if (this._deferGrowth) {
        this._scheduleGrow();
        // proceed with current capacity; some points may be dropped or ring-evicted
      } else {
        const needed = this.size + chunk.length;
        while (this.capacity < needed && this.capacity < this.policy.maxPoints) {
          this._grow();
        }
      }
    }

    for (const point of chunk) {
      if (this.size < this.capacity) {
        const slot = (this.head + this.size) % this.capacity;
        this.writeSlot(slot, point);
        this._addSlotToSpatialIndex(slot);
        if (this.trackedAttr !== undefined) {
          this.rangeExpandAdd(this.attrVals[slot]);
        }
        this.size++;
      } else if (this.policy.mode === "drop-oldest") {
        if (this._useKLookahead) {
          this._kLookaheadSwapToHead(Date.now() - this._epochMs);
        }
        const slot = this.head;
        this._removeSlotFromSpatialIndex(slot);
        const oldAttrVal = this.trackedAttr !== undefined ? this.attrVals[slot] : 0;
        this.writeSlot(slot, point);
        this._addSlotToSpatialIndex(slot);
        if (this.trackedAttr !== undefined) {
          this.rangeUpdateOnOverwrite(oldAttrVal, this.attrVals[slot]);
        }
        this.head = (this.head + 1) % this.capacity;
        this.droppedPoints++;
      } else {
        this.droppedPoints++;
      }
    }

    return this.getStats();
  }

  snapshot(): PointRecord[] {
    const result = new Array<PointRecord>(this.size);
    for (let i = 0; i < this.size; i++) {
      const slot = (this.head + i) % this.capacity;
      const item = this.items[slot];
      result[i] = item !== undefined
        ? item
        : { x: this.xs[slot], y: this.ys[slot], z: this.zs[slot], attributes: this.synthesizePackedAttributes(slot) };
    }
    return result;
  }

  /**
   * Ingest pre-packed typed-array data, bypassing JS object construction on
   * the hot path. Used by the worker ingest bridge: the Worker packs PointRecord
   * objects into typed arrays off the main thread, then postMessages Transferable
   * buffers back; the main thread calls ingestFromBinary with those buffers.
   *
   * Semantics are identical to ingest(): ring, drop policy, droppedPoints.
   * Items slots for binary-ingested points are set to undefined (no AoS object).
   * snapshot() synthesizes minimal PointRecord values from SoA for these slots.
   *
   * rangeHints (optional) allow the worker to pre-supply the min/max for
   * the tracked attribute so the main thread can skip an immediate dirty scan.
   */
  ingestFromBinary(
    xyz: Float32Array,
    attributes: PackedAttributeChannel[] | undefined,
    count: number,
    rangeHints?: Record<string, { min: number; max: number }>
  ): BufferStats {
    // Dynamic: grow to fit incoming data (deferred off-path by default)
    if (this._isDynamic && this.size + count > this.capacity && this.capacity < this.policy.maxPoints) {
      if (this._deferGrowth) {
        this._scheduleGrow();
        // proceed with current capacity; excess points may be dropped or ring-evicted
      } else {
        const needed = this.size + count;
        while (this.capacity < needed && this.capacity < this.policy.maxPoints) {
          this._grow();
        }
      }
    }

    const nowRelEpoch = Date.now() - this._epochMs;
    const importanceChannel = (this._importanceField !== undefined && attributes)
      ? attributes.find((ch) => ch.key === this._importanceField)
      : undefined;
    const classificationChannel = (this._classificationWeights !== undefined && attributes)
      ? attributes.find((ch) => ch.key === this._classificationField)
      : undefined;

    const trackedChannel = this.trackedAttr !== undefined
      ? attributes?.find((channel) => channel.key === this.trackedAttr)
      : undefined;
    const attributeStores = (attributes ?? []).map((channel) => ({
      channel,
      store: this.ensurePackedAttributeStore(channel.key),
      chanSeq: this.ensureChannelWriteSeq(channel.key)
    }));
    const hasPackedAttributes = attributeStores.length > 0;

    const writeBinarySlot = (slot: number, pointIndex: number): void => {
      const seq = this.writeSeqCounter++;
      this.slotWriteSeq[slot] = seq;

      for (const { channel, store, chanSeq } of attributeStores) {
        store.values[slot] = channel.values[pointIndex];
        store.present[slot] = channel.present[pointIndex];
        chanSeq[slot] = seq; // stamp this channel as current for this slot
      }
      if (this.trackedAttr !== undefined) {
        this.attrVals[slot] = trackedChannel !== undefined && trackedChannel.present[pointIndex] === 1
          ? trackedChannel.values[pointIndex]
          : 0;
      }
      this.importanceBuffer[slot] = importanceChannel !== undefined && importanceChannel.present[pointIndex] === 1
        ? importanceChannel.values[pointIndex]
        : 1.0;
      // Classification weight override
      if (this._classificationWeights !== undefined && classificationChannel !== undefined
          && classificationChannel.present[pointIndex] === 1) {
        const cv = Math.round(classificationChannel.values[pointIndex]);
        const w  = this._classificationWeights[cv];
        if (w !== undefined) this.importanceBuffer[slot] = w;
      }
      this.slotTimestampMs[slot] = nowRelEpoch;
    }

    for (let i = 0; i < count; i++) {
      const i3 = i * 3;
      if (this.size < this.capacity) {
        const slot = (this.head + this.size) % this.capacity;
        this.xs[slot] = xyz[i3];
        this.ys[slot] = xyz[i3 + 1];
        this.zs[slot] = xyz[i3 + 2];
        this.items[slot] = undefined;
        writeBinarySlot(slot, i);
        this._addSlotToSpatialIndex(slot);
        if (this.trackedAttr !== undefined) {
          this.rangeExpandAdd(this.attrVals[slot]);
        }
        this.size++;
      } else if (this.policy.mode === "drop-oldest") {
        if (this._useKLookahead) {
          this._kLookaheadSwapToHead(nowRelEpoch);
        }
        const slot = this.head;
        this._removeSlotFromSpatialIndex(slot);
        const oldAttrVal = this.trackedAttr !== undefined ? this.attrVals[slot] : 0;
        this.xs[slot] = xyz[i3];
        this.ys[slot] = xyz[i3 + 1];
        this.zs[slot] = xyz[i3 + 2];
        this.items[slot] = undefined;
        writeBinarySlot(slot, i);
        this._addSlotToSpatialIndex(slot);
        if (this.trackedAttr !== undefined) {
          this.rangeUpdateOnOverwrite(oldAttrVal, this.attrVals[slot]);
        }
        this.head = (this.head + 1) % this.capacity;
        this.droppedPoints++;
      } else {
        this.droppedPoints++;
      }
    }

    if (hasPackedAttributes && rangeHints !== undefined && this.trackedAttr !== undefined) {
      const hint = rangeHints[this.trackedAttr];
      if (hint !== undefined) {
        if (hint.min < this.attrRangeMin) this.attrRangeMin = hint.min;
        if (hint.max > this.attrRangeMax) this.attrRangeMax = hint.max;
      }
    }

    return this.getStats();
  }

  /** Update attrVals and rgbScale when the tracked colorBy attribute changes. */
  private _syncColorBy(colorBy: string | undefined): void {
    this.trackedAttr  = colorBy;
    this.attrRangeMin = Infinity;
    this.attrRangeMax = -Infinity;
    this.attrRangeDirty = true;
    if (colorBy === "rgb") {
      let rgbMax = 1.0;
      for (const key of ["red", "green", "blue"] as const) {
        const vals = this.packedAttrValuesByKey.get(key);
        if (vals) {
          for (let i = 0; i < this.size; i++) {
            const v = vals[(this.head + i) % this.capacity];
            if (v > rgbMax) rgbMax = v;
          }
        }
      }
      this._rgbScale = rgbMax > 255.5 ? 65535 : rgbMax > 1.5 ? 255 : 1;
    } else if (colorBy !== undefined) {
      for (let i = 0; i < this.size; i++) {
        const slot = (this.head + i) % this.capacity;
        const item = this.items[slot] as PointRecord | undefined;
        if (item !== undefined) {
          this.attrVals[slot] = item.attributes?.[colorBy] ?? 0;
        } else {
          const packedValues  = this.packedAttrValuesByKey.get(colorBy);
          const packedPresence = this.packedAttrPresenceByKey.get(colorBy);
          this.attrVals[slot] = packedValues !== undefined && packedPresence !== undefined && packedPresence[slot] === 1
            ? packedValues[slot]
            : 0;
        }
        const v = this.attrVals[slot];
        if (v < this.attrRangeMin) this.attrRangeMin = v;
        if (v > this.attrRangeMax) this.attrRangeMax = v;
      }
      this.attrRangeDirty = false;
    }
  }

  /** Scan attrVals to recompute min/max when dirty (e.g. after ring eviction). */
  private _resolveAttrRange(): void {
    let minVal = Infinity, maxVal = -Infinity;
    for (let i = 0; i < this.size; i++) {
      const v = this.attrVals[(this.head + i) % this.capacity];
      if (v < minVal) minVal = v;
      if (v > maxVal) maxVal = v;
    }
    this.attrRangeMin = minVal > maxVal ? 0 : minVal;
    this.attrRangeMax = minVal > maxVal ? 1 : maxVal;
    this.attrRangeDirty = false;
  }

  /** Spatial-index copy path: stride=1, isVisible set, spatial index active. */
  private _copyWithSpatialCulling(
    positions: Float32Array,
    colors: Float32Array,
    colorBy: string | undefined,
    isRgbMode: boolean,
    rgbScale: number,
    rVals: Float32Array | undefined,
    gVals: Float32Array | undefined,
    bVals: Float32Array | undefined,
    maxCount: number,
    isVisible: (x: number, y: number, z: number) => boolean,
  ): number {
    let count = 0;
    const cellKeys = Array.from(this.cellSlots.keys()).sort((a, b) => a - b);

    if (colorBy !== undefined) {
      const minVal = this.attrRangeMin;
      const maxVal = this.attrRangeMax > this.attrRangeMin ? this.attrRangeMax : this.attrRangeMin + 1;
      for (const key of cellKeys) {
        if (count >= maxCount) break;
        const [cx, cy, cz] = cellCenter(key);
        const slots = this.cellSlots.get(key)!;
        if (isVisible(cx, cy, cz)) {
          for (const slot of slots) {
            if (count >= maxCount) break;
            const i3 = count * 3;
            positions[i3] = this.xs[slot]; positions[i3 + 1] = this.ys[slot]; positions[i3 + 2] = this.zs[slot];
            if (isRgbMode) {
              const sc = rgbScale;
              colors[i3]     = Math.min(1, (rVals?.[slot] ?? 0) / sc);
              colors[i3 + 1] = Math.min(1, (gVals?.[slot] ?? 0) / sc);
              colors[i3 + 2] = Math.min(1, (bVals?.[slot] ?? 0) / sc);
            } else {
              writeScalarToRgbBuffer(this.attrVals[slot], minVal, maxVal, colors, i3, "blue-red");
            }
            count++;
          }
        } else {
          for (const slot of slots) {
            if (count >= maxCount) break;
            const px = this.xs[slot], py = this.ys[slot], pz = this.zs[slot];
            if (!isVisible(px, py, pz)) continue;
            const i3 = count * 3;
            positions[i3] = px; positions[i3 + 1] = py; positions[i3 + 2] = pz;
            if (isRgbMode) {
              const sc = rgbScale;
              colors[i3]     = Math.min(1, (rVals?.[slot] ?? 0) / sc);
              colors[i3 + 1] = Math.min(1, (gVals?.[slot] ?? 0) / sc);
              colors[i3 + 2] = Math.min(1, (bVals?.[slot] ?? 0) / sc);
            } else {
              writeScalarToRgbBuffer(this.attrVals[slot], minVal, maxVal, colors, i3, "blue-red");
            }
            count++;
          }
        }
      }
    } else {
      for (const key of cellKeys) {
        if (count >= maxCount) break;
        const [cx, cy, cz] = cellCenter(key);
        const slots = this.cellSlots.get(key)!;
        if (isVisible(cx, cy, cz)) {
          for (const slot of slots) {
            if (count >= maxCount) break;
            const i3 = count * 3;
            positions[i3] = this.xs[slot]; positions[i3 + 1] = this.ys[slot]; positions[i3 + 2] = this.zs[slot];
            colors[i3] = 1; colors[i3 + 1] = 1; colors[i3 + 2] = 1;
            count++;
          }
        } else {
          for (const slot of slots) {
            if (count >= maxCount) break;
            const px = this.xs[slot], py = this.ys[slot], pz = this.zs[slot];
            if (!isVisible(px, py, pz)) continue;
            const i3 = count * 3;
            positions[i3] = px; positions[i3 + 1] = py; positions[i3 + 2] = pz;
            colors[i3] = 1; colors[i3 + 1] = 1; colors[i3 + 2] = 1;
            count++;
          }
        }
      }
    }
    return count;
  }

  /** Linear ring-scan copy path (stride, optional frustum, optional time window). */
  private _copyLinear(
    positions: Float32Array,
    colors: Float32Array,
    stride: number,
    colorBy: string | undefined,
    isRgbMode: boolean,
    rgbScale: number,
    rVals: Float32Array | undefined,
    gVals: Float32Array | undefined,
    bVals: Float32Array | undefined,
    maxCount: number,
    isVisible: ((x: number, y: number, z: number) => boolean) | undefined,
    timeWindowCutoffRelEpoch: number | undefined,
  ): number {
    let count = 0;
    if (colorBy !== undefined) {
      const minVal = this.attrRangeMin;
      const maxVal = this.attrRangeMax > this.attrRangeMin ? this.attrRangeMax : this.attrRangeMin + 1;
      for (let i = 0; i < this.size && count < maxCount; i += stride) {
        const slot = (this.head + i) % this.capacity;
        if (timeWindowCutoffRelEpoch !== undefined && this.slotTimestampMs[slot] < timeWindowCutoffRelEpoch) continue;
        const px = this.xs[slot], py = this.ys[slot], pz = this.zs[slot];
        if (isVisible !== undefined && !isVisible(px, py, pz)) continue;
        const i3 = count * 3;
        positions[i3] = px; positions[i3 + 1] = py; positions[i3 + 2] = pz;
        if (isRgbMode) {
          const sc = rgbScale;
          colors[i3]     = Math.min(1, (rVals?.[slot] ?? 0) / sc);
          colors[i3 + 1] = Math.min(1, (gVals?.[slot] ?? 0) / sc);
          colors[i3 + 2] = Math.min(1, (bVals?.[slot] ?? 0) / sc);
        } else {
          writeScalarToRgbBuffer(this.attrVals[slot], minVal, maxVal, colors, i3, "blue-red");
        }
        count++;
      }
    } else {
      for (let i = 0; i < this.size && count < maxCount; i += stride) {
        const slot = (this.head + i) % this.capacity;
        if (timeWindowCutoffRelEpoch !== undefined && this.slotTimestampMs[slot] < timeWindowCutoffRelEpoch) continue;
        const px = this.xs[slot], py = this.ys[slot], pz = this.zs[slot];
        if (isVisible !== undefined && !isVisible(px, py, pz)) continue;
        const i3 = count * 3;
        positions[i3] = px; positions[i3 + 1] = py; positions[i3 + 2] = pz;
        colors[i3] = 1; colors[i3 + 1] = 1; colors[i3 + 2] = 1;
        count++;
      }
    }
    return count;
  }

  /**
   * Write the current ring contents directly into caller-owned typed arrays,
   * sampling every `stride` points (stride=1 → full detail, stride=2 → half, etc.).
   *
   * Complexity: O(size / stride) — lower LOD levels are proportionally cheaper.
   * No intermediate PointRecord[] is allocated on this path.
   *
   * When spatialCulling is on, a persistent spatial index iterates only points in
   * visible cells plus per-point tests for boundary cells — scales to 15M+ when
   * much of the cloud is off-screen.
   *
   * @param renderBudget Optional cap on number of rendered points.
   * @param isVisible    Optional frustum predicate (x, y, z world-space coords).
   * @returns Number of points written.
   */
  copyToTypedArrays(
    positions: Float32Array,
    colors: Float32Array,
    stride: number,
    colorBy: string | undefined,
    renderBudget?: number,
    isVisible?: (x: number, y: number, z: number) => boolean,
    spatialCulling?: boolean,
    /** Epoch-relative cutoff — skip points with slotTimestampMs < this value. */
    timeWindowCutoffRelEpoch?: number
  ): number {
    if (!Number.isInteger(stride) || stride < 1) {
      throw new Error("stride must be a positive integer");
    }

    if (colorBy !== this.trackedAttr) this._syncColorBy(colorBy);

    const isRgbMode = colorBy === "rgb";
    const rVals = isRgbMode ? this.packedAttrValuesByKey.get("red")   : undefined;
    const gVals = isRgbMode ? this.packedAttrValuesByKey.get("green") : undefined;
    const bVals = isRgbMode ? this.packedAttrValuesByKey.get("blue")  : undefined;

    // If rgb scale was computed while size=0 (data hadn't arrived yet), recompute now.
    if (isRgbMode && this.attrRangeDirty && this.size > 0) {
      let rgbMax = 1.0;
      for (const vals of [rVals, gVals, bVals]) {
        if (vals) {
          for (let i = 0; i < this.size; i++) {
            const v = vals[(this.head + i) % this.capacity];
            if (v > rgbMax) rgbMax = v;
          }
        }
      }
      this._rgbScale = rgbMax > 255.5 ? 65535 : rgbMax > 1.5 ? 255 : 1;
      this.attrRangeDirty = false;
    }

    // Resolve dirty range caused by ring eviction (not a colorBy change).
    if (colorBy !== undefined && colorBy !== "rgb" && this.attrRangeDirty) this._resolveAttrRange();

    const maxCount = renderBudget ?? Infinity;

    if (spatialCulling !== false && isVisible !== undefined && stride === 1
        && this.size > 0 && this._maintainSpatialIndex && this.cellSlots.size > 0) {
      return this._copyWithSpatialCulling(
        positions, colors, colorBy, isRgbMode, this._rgbScale, rVals, gVals, bVals, maxCount, isVisible
      );
    }

    return this._copyLinear(
      positions, colors, stride, colorBy, isRgbMode, this._rgbScale,
      rVals, gVals, bVals, maxCount, isVisible, timeWindowCutoffRelEpoch
    );
  }

  /** Pack R8G8B8 into u32 bitcast-as-f32; shader (colorMode=2) decodes per-point colour. */
  private _copySoARgb(posOut: Float32Array, attrOut: Float32Array, sz: number, cap: number): void {
    const redV = this.packedAttrValuesByKey.get("red"),   redP = this.packedAttrPresenceByKey.get("red");
    const grnV = this.packedAttrValuesByKey.get("green"), grnP = this.packedAttrPresenceByKey.get("green");
    const bluV = this.packedAttrValuesByKey.get("blue"),  bluP = this.packedAttrPresenceByKey.get("blue");
    const attrU32 = new Uint32Array(attrOut.buffer, attrOut.byteOffset, attrOut.length);
    for (let i = 0; i < sz; i++) {
      const slot = (this.head + i) % cap;
      const p = i * 4;
      posOut[p] = this.xs[slot]; posOut[p + 1] = this.ys[slot];
      posOut[p + 2] = this.zs[slot]; posOut[p + 3] = 1.0;
      let r = 0, g = 0, b = 0;
      const item = this.items[slot];
      if (item !== undefined) {
        r = (item.attributes?.["red"]   ?? 0) & 0xFF;
        g = (item.attributes?.["green"] ?? 0) & 0xFF;
        b = (item.attributes?.["blue"]  ?? 0) & 0xFF;
      } else {
        if (redV && redP && redP[slot] === 1) r = redV[slot] & 0xFF;
        if (grnV && grnP && grnP[slot] === 1) g = grnV[slot] & 0xFF;
        if (bluV && bluP && bluP[slot] === 1) b = bluV[slot] & 0xFF;
      }
      attrU32[i] = r | (g << 8) | (b << 16);
    }
  }

  private _copySoAClassification(posOut: Float32Array, attrOut: Float32Array, sz: number, cap: number): void {
    const classV = this.packedAttrValuesByKey.get("classification");
    const classP = this.packedAttrPresenceByKey.get("classification");
    const attrU32 = new Uint32Array(attrOut.buffer, attrOut.byteOffset, attrOut.length);
    for (let i = 0; i < sz; i++) {
      const slot = (this.head + i) % cap;
      const p = i * 4;
      posOut[p] = this.xs[slot]; posOut[p + 1] = this.ys[slot];
      posOut[p + 2] = this.zs[slot]; posOut[p + 3] = 1.0;
      let cls = 0;
      const item = this.items[slot];
      if (item !== undefined) cls = item.attributes?.["classification"] ?? 0;
      else if (classV && classP && classP[slot] === 1) cls = classV[slot];
      attrU32[i] = lasClassToU32(cls);
    }
  }

  private _copySoAScalar(
    posOut: Float32Array, attrOut: Float32Array, sz: number, cap: number, colorBy: string,
  ): { attrMin: number; attrMax: number } {
    const attrValues  = this.packedAttrValuesByKey.get(colorBy);
    const attrPresence = this.packedAttrPresenceByKey.get(colorBy);
    let attrMin = Infinity, attrMax = -Infinity;
    for (let i = 0; i < sz; i++) {
      const slot = (this.head + i) % cap;
      const p = i * 4;
      posOut[p] = this.xs[slot]; posOut[p + 1] = this.ys[slot];
      posOut[p + 2] = this.zs[slot]; posOut[p + 3] = 1.0;
      let av = 0;
      const item = this.items[slot];
      if (item !== undefined) av = item.attributes?.[colorBy] ?? 0;
      else if (attrValues !== undefined && attrPresence !== undefined && attrPresence[slot] === 1) av = attrValues[slot];
      attrOut[i] = av;
      if (av < attrMin) attrMin = av;
      if (av > attrMax) attrMax = av;
    }
    return { attrMin, attrMax };
  }

  private _copySoANone(posOut: Float32Array, attrOut: Float32Array, sz: number, cap: number): void {
    for (let i = 0; i < sz; i++) {
      const slot = (this.head + i) % cap;
      const p = i * 4;
      posOut[p] = this.xs[slot]; posOut[p + 1] = this.ys[slot];
      posOut[p + 2] = this.zs[slot]; posOut[p + 3] = 1.0;
      attrOut[i] = 0;
    }
  }

  /**
   * Copy all ring-buffer contents into vec4 position and f32 attribute arrays
   * suitable for direct GPU upload (device.queue.writeBuffer).
   *
   * posOut  — capacity*4 floats (vec4<f32>: x,y,z,1)
   * attrOut — capacity floats (one f32 attribute per point)
   * colorBy — attribute key; when undefined, attrOut is zeroed
   *
   * Returns { count, attrMin, attrMax }. O(size) — GPU handles culling.
   */
  copySoAForGPU(
    posOut: Float32Array,
    attrOut: Float32Array,
    colorBy: string | undefined
  ): { count: number; attrMin: number; attrMax: number } {
    const sz = this.size, cap = this.capacity;
    let attrMin = 0, attrMax = 1;

    if (colorBy === "rgb") {
      this._copySoARgb(posOut, attrOut, sz, cap);
    } else if (colorBy === "classification") {
      this._copySoAClassification(posOut, attrOut, sz, cap);
    } else if (colorBy !== undefined) {
      ({ attrMin, attrMax } = this._copySoAScalar(posOut, attrOut, sz, cap, colorBy));
      if (attrMin > attrMax) { attrMin = 0; attrMax = 1; }
    } else {
      this._copySoANone(posOut, attrOut, sz, cap);
    }

    return { count: sz, attrMin, attrMax };
  }

  reset(): void {
    for (let i = 0; i < this.size; i++) {
      this.items[(this.head + i) % this.capacity] = undefined;
    }
    this.head = 0;
    this.size = 0;
    this.droppedPoints = 0;
    this._growthPending = false;
    this.trackedAttr = undefined;
    this.packedAttrValuesByKey.clear();
    this.packedAttrPresenceByKey.clear();
    this.writeSeqCounter = 1.0;
    this.slotWriteSeq.fill(0);
    this.importanceBuffer.fill(1);
    this.slotTimestampMs.fill(0);
    for (const arr of this.channelWriteSeq.values()) {
      arr.fill(0);
    }
    this.channelWriteSeq.clear();
    this.cellSlots.clear();
    if (this._maintainSpatialIndex && this.slotToCellKey.length > 0) {
      this.slotToCellKey.fill(0);
    }
    this.attrRangeMin = Infinity;
    this.attrRangeMax = -Infinity;
    this.attrRangeDirty = true;
  }

  getStats(): BufferStats {
    return {
      totalPoints: this.size,
      droppedPoints: this.droppedPoints,
      // Under pressure when we've reached the hard ceiling (maxPoints).
      // In pre-alloc mode capacity === maxPoints, so the result is identical
      // to the previous `this.size >= this.capacity` check.
      isUnderPressure: this.size >= this.policy.maxPoints
    };
  }

  /** Expose range cache state for testing/telemetry. */
  getRangeCache(): { min: number; max: number; dirty: boolean } {
    return { min: this.attrRangeMin, max: this.attrRangeMax, dirty: this.attrRangeDirty };
  }

  /**
   * Returns the age in milliseconds of the oldest retained point.
   * Scans all active slots — O(size). Returns 0 if buffer is empty.
   * Timestamps are always written on ingest so this is valid regardless of
   * whether the importance engine is active. Used for the staleness guarantee metric.
   */
  getOldestRetainedAgeMs(): number {
    if (this.size === 0) return 0;
    const nowRelEpoch = Date.now() - this._epochMs;
    let minTs = Infinity;
    for (let k = 0; k < this.size; k++) {
      const slot = (this.head + k) % this.capacity;
      const ts = this.slotTimestampMs[slot];
      if (ts < minTs) minTs = ts;
    }
    return minTs === Infinity ? 0 : Math.max(0, nowRelEpoch - minTs);
  }

  /** Epoch timestamp (ms) used as the origin for all relative slot timestamps. */
  get epochMs(): number { return this._epochMs; }

  /**
   * Resolve the importance field at runtime (called after first ingest when
   * importanceField was "auto"). Enables K-lookahead eviction with the
   * given attribute key from this point forward; does not backfill prior slots.
   */
  setImportanceField(field: string): void {
    this._importanceField = field;
    this._useKLookahead = true;
  }

  /**
   * Compute temporal statistics for the current buffer contents. O(size).
   *
   * @param nowMs       Current wall-clock time (Date.now()).
   * @param timeWindowMs When set (> 0), also counts points ingested within this window.
   */
  getTemporalStats(nowMs: number, timeWindowMs?: number): TemporalStats {
    if (this.size === 0) {
      return { oldestPointAgeMs: 0, newestPointAgeMs: 0, windowedCount: 0, totalCount: 0 };
    }
    const nowRel = nowMs - this._epochMs;
    let maxAge = -Infinity;
    let minAge = Infinity;
    const hasWindow = timeWindowMs !== undefined && timeWindowMs > 0;
    const cutoff = hasWindow ? nowRel - timeWindowMs! : 0;
    // When no time window is active every point counts — skip the per-slot comparison.
    let windowed = hasWindow ? 0 : this.size;
    for (let k = 0; k < this.size; k++) {
      const ts  = this.slotTimestampMs[(this.head + k) % this.capacity];
      const age = nowRel - ts;
      if (age > maxAge) maxAge = age;
      if (age < minAge) minAge = age;
      if (hasWindow && ts >= cutoff) windowed++;
    }
    return {
      oldestPointAgeMs: Math.max(0, maxAge),
      newestPointAgeMs: Math.max(0, minAge),
      windowedCount: windowed,
      totalCount: this.size,
    };
  }

  /**
   * Copy epoch-relative ingest timestamps for all active slots into `out[0..size-1]`.
   * Used for the one-time GPU init upload path (copySoAForGPU). O(size).
   */
  copyTimestampsForGPU(out: Float32Array): void {
    const sz  = this.size;
    const cap = this.capacity;
    for (let i = 0; i < sz; i++) {
      out[i] = this.slotTimestampMs[(this.head + i) % cap];
    }
  }

  /**
   * Find the nearest visible point to a screen-space click position.
   *
   * Projects every active point through the supplied VP matrix, tests against
   * a screen-space pick radius, and returns the best candidate.
   *
   * Primary sort key: importance (higher wins — best for stacked points).
   * Secondary sort key: screen distance (closer wins when importance is equal).
   *
   * @param vpElements  Column-major 4×4 view-projection matrix (Three.js `Matrix4.elements`).
   * @param clickX      Click X in CSS pixels measured from the canvas left edge.
   * @param clickY      Click Y in CSS pixels measured from the canvas top edge.
   * @param canvasW     Canvas width in CSS pixels.
   * @param canvasH     Canvas height in CSS pixels.
   * @param pickRadius  Pick radius in CSS pixels (default 8).
   * @returns Pick result, or null when no point falls within the radius.
   */
  pickNearest(
    vpElements: ArrayLike<number>,
    clickX: number,
    clickY: number,
    canvasW: number,
    canvasH: number,
    pickRadius: number,
    pickStrategy: PickStrategy = "highestImportance",
  ): { slotIndex: number; x: number; y: number; z: number; screenDist: number; importance: number; attributes: Record<string, number> } | null {
    return pickNearestPoint(
      {
        size: this.size, capacity: this.capacity, head: this.head,
        xs: this.xs, ys: this.ys, zs: this.zs,
        importanceBuffer: this.importanceBuffer, items: this.items,
        packedAttrValuesByKey: this.packedAttrValuesByKey,
        packedAttrPresenceByKey: this.packedAttrPresenceByKey,
        slotTimestampMs: this.slotTimestampMs,
      },
      vpElements, clickX, clickY, canvasW, canvasH, pickRadius, pickStrategy,
    );
  }

}
