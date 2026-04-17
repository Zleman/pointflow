import { describe, expect, it, vi } from "vitest";
import { WorkerBridge, packChunk } from "../src/worker/worker-bridge";
import type { IngestResponse, RangeHint } from "../src/worker/worker-protocol";

/**
 * Minimal Worker stub — captures postMessage calls and lets tests drive
 * synthetic responses by calling simulate(). No actual Worker threads.
 */
class StubWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  readonly postMessageCalls: Array<{ data: unknown }> = [];
  terminated = false;

  postMessage(data: unknown): void {
    this.postMessageCalls.push({ data });
  }

  simulate(response: IngestResponse): void {
    this.onmessage?.(new MessageEvent("message", { data: response }));
  }

  terminate(): void {
    this.terminated = true;
  }
}


describe("packChunk", () => {
  it("packs xyz into flat Float32Array", () => {
    const { xyz, count } = packChunk({
      points: [
        { x: 1, y: 2, z: 3 },
        { x: 4, y: 5, z: 6 }
      ]
    });
    expect(count).toBe(2);
    expect(xyz[0]).toBe(1);
    expect(xyz[1]).toBe(2);
    expect(xyz[2]).toBe(3);
    expect(xyz[3]).toBe(4);
    expect(xyz[4]).toBe(5);
    expect(xyz[5]).toBe(6);
  });

  it("packs all attribute channels with presence masks", () => {
    const { attributes, count } = packChunk({
      points: [
        { x: 0, y: 0, z: 0, attributes: { velocity: 0.5, intensity: 0.2 } },
        { x: 1, y: 0, z: 0, attributes: { velocity: 0.8 } }
      ]
    });
    expect(count).toBe(2);
    expect(attributes).toHaveLength(2);
    const velocity = attributes!.find((channel) => channel.key === "velocity");
    const intensity = attributes!.find((channel) => channel.key === "intensity");
    expect(velocity).toBeDefined();
    expect(intensity).toBeDefined();
    expect(velocity!.values[0]).toBeCloseTo(0.5);
    expect(velocity!.values[1]).toBeCloseTo(0.8);
    expect(velocity!.present[0]).toBe(1);
    expect(velocity!.present[1]).toBe(1);
    expect(intensity!.values[0]).toBeCloseTo(0.2);
    expect(intensity!.values[1]).toBe(0);
    expect(intensity!.present[0]).toBe(1);
    expect(intensity!.present[1]).toBe(0);
  });

  it("returns attributes undefined when no attributes present", () => {
    const { attributes } = packChunk({
      points: [{ x: 0, y: 0, z: 0 }]
    });
    expect(attributes).toBeUndefined();
  });

  it("marks missing attribute values via presence mask", () => {
    const { attributes } = packChunk({
      points: [
        { x: 0, y: 0, z: 0, attributes: { velocity: 0.3, intensity: 0.7 } },
        { x: 1, y: 0, z: 0 } // no attributes
      ]
    });
    const velocity = attributes!.find((channel) => channel.key === "velocity");
    const intensity = attributes!.find((channel) => channel.key === "intensity");
    expect(velocity!.values[0]).toBeCloseTo(0.3);
    expect(velocity!.values[1]).toBe(0);
    expect(velocity!.present[0]).toBe(1);
    expect(velocity!.present[1]).toBe(0);
    expect(intensity!.values[0]).toBeCloseTo(0.7);
    expect(intensity!.present[1]).toBe(0);
  });

  it("returns count 0 and empty arrays for empty chunk", () => {
    const { xyz, attributes, count } = packChunk({ points: [] });
    expect(count).toBe(0);
    expect(xyz).toHaveLength(0);
    expect(attributes).toBeUndefined();
  });
});


describe("WorkerBridge", () => {
  it("calls onIngest with xyz, count, requestId, and rangeHints when worker responds with valid PREPROCESSED", () => {
    const stub = new StubWorker();
    const received: Array<{ count: number; requestId: number; rangeHints: Record<string, RangeHint> }> = [];
    const nextRequestIdRef = { current: 0 };
    const bridge = new WorkerBridge(stub as unknown as Worker, (_xyz, _attributes, count, requestId, rangeHints) => {
      received.push({ count, requestId, rangeHints });
    }, nextRequestIdRef);

    const xyz = new Float32Array([1, 2, 3, 4, 5, 6]);
    stub.simulate({
      type: "PREPROCESSED", requestId: 0, xyz, attributes: undefined, count: 2,
      rangeHints: { velocity: { min: 0.1, max: 0.9 } }
    });

    expect(received).toHaveLength(1);
    expect(received[0].count).toBe(2);
    expect(received[0].requestId).toBe(0);
    expect(received[0].rangeHints.velocity).toEqual({ min: 0.1, max: 0.9 });
    bridge.terminate();
    expect(stub.terminated).toBe(true);
  });

  it("passes multi-attribute channels and rangeHints through to onIngest", () => {
    const stub = new StubWorker();
    let capturedAttributes: IngestResponse["attributes"];
    let capturedHints: Record<string, RangeHint> = {};
    const nextRequestIdRef = { current: 0 };
    const bridge = new WorkerBridge(stub as unknown as Worker, (_xyz, attributes, _count, _requestId, rangeHints) => {
      capturedAttributes = attributes;
      capturedHints = rangeHints;
    }, nextRequestIdRef);

    const attributes = [
      { key: "velocity", values: new Float32Array([0.5, 0.8]), present: new Uint8Array([1, 1]) },
      { key: "intensity", values: new Float32Array([0.1, 0]), present: new Uint8Array([1, 0]) }
    ];
    stub.simulate({
      type: "PREPROCESSED",
      requestId: 0,
      xyz: new Float32Array(6),
      attributes,
      count: 2,
      rangeHints: { velocity: { min: 0.5, max: 0.8 }, intensity: { min: 0.1, max: 0.1 } }
    });

    expect(capturedAttributes).toBe(attributes);
    expect(capturedHints.velocity).toEqual({ min: 0.5, max: 0.8 });
    bridge.terminate();
  });

  it("ignores unknown or malformed messages and does not call onIngest", () => {
    const stub = new StubWorker();
    const onIngest = vi.fn();
    const nextRequestIdRef = { current: 0 };
    const bridge = new WorkerBridge(stub as unknown as Worker, onIngest, nextRequestIdRef);

    stub.onmessage?.(new MessageEvent("message", { data: { type: "UNKNOWN" } }));
    expect(onIngest).not.toHaveBeenCalled();

    stub.onmessage?.(new MessageEvent("message", { data: null }));
    stub.onmessage?.(new MessageEvent("message", { data: { type: "PREPROCESSED" } }));
    stub.onmessage?.(new MessageEvent("message", { data: { type: "PREPROCESSED", requestId: 0, count: 1 } }));
    stub.onmessage?.(new MessageEvent("message", {
      data: {
        type: "PREPROCESSED",
        requestId: 0,
        xyz: new Float32Array(3),
        attributes: [{ key: "velocity", values: new Float32Array([1]), present: new Uint8Array(0) }],
        count: 1,
        rangeHints: {}
      }
    }));
    expect(onIngest).not.toHaveBeenCalled();

    bridge.terminate();
  });

  it("drops stale responses when requestId is below caller-defined minimum", () => {
    const stub = new StubWorker();
    const received: number[] = [];
    const nextRequestIdRef = { current: 0 };
    const minAcceptableRef = { current: 0 };
    const bridge = new WorkerBridge(stub as unknown as Worker, (_xyz, _attributes, _count, requestId) => {
      if (requestId >= minAcceptableRef.current) received.push(requestId);
    }, nextRequestIdRef);

    stub.simulate({ type: "PREPROCESSED", requestId: 0, xyz: new Float32Array(6), attributes: undefined, count: 2, rangeHints: {} });
    expect(received).toEqual([0]);

    minAcceptableRef.current = 2;
    stub.simulate({ type: "PREPROCESSED", requestId: 1, xyz: new Float32Array(6), attributes: undefined, count: 2, rangeHints: {} });
    expect(received).toEqual([0]);

    stub.simulate({ type: "PREPROCESSED", requestId: 2, xyz: new Float32Array(6), attributes: undefined, count: 2, rangeHints: {} });
    expect(received).toEqual([0, 2]);
    bridge.terminate();
  });

  it("post() sends raw points (not pre-packed typed arrays) for off-thread packing", () => {
    const stub = new StubWorker();
    const nextRequestIdRef = { current: 0 };
    const bridge = new WorkerBridge(stub as unknown as Worker, () => {}, nextRequestIdRef);

    bridge.post({ points: [{ x: 1, y: 2, z: 3 }] });

    expect(stub.postMessageCalls).toHaveLength(1);
    const msg = stub.postMessageCalls[0].data as { type: string; requestId: number; points: unknown[] };
    expect(msg.type).toBe("INGEST");
    expect(msg.requestId).toBe(0);
    expect(Array.isArray(msg.points)).toBe(true);
    expect(msg.points).toHaveLength(1);
    expect(nextRequestIdRef.current).toBe(1);
    bridge.terminate();
  });

  it("post() sends points with attribute data for worker packing", () => {
    const stub = new StubWorker();
    const nextRequestIdRef = { current: 0 };
    const bridge = new WorkerBridge(stub as unknown as Worker, () => {}, nextRequestIdRef);

    bridge.post({
      points: [
        { x: 1, y: 2, z: 3, attributes: { velocity: 0.5, intensity: 0.2 } },
        { x: 4, y: 5, z: 6, attributes: { velocity: 0.8 } }
      ]
    });

    const msg = stub.postMessageCalls[0].data as { points: Array<{ attributes?: Record<string, number> }> };
    expect(msg.points).toHaveLength(2);
    expect(msg.points[0].attributes?.velocity).toBeCloseTo(0.5);
    expect(msg.points[1].attributes?.velocity).toBeCloseTo(0.8);
    bridge.terminate();
  });

  it("tracks the next request id after each post", () => {
    const stub = new StubWorker();
    const nextRequestIdRef = { current: 0 };
    const bridge = new WorkerBridge(stub as unknown as Worker, () => {}, nextRequestIdRef);

    bridge.post({ points: [{ x: 1, y: 2, z: 3 }] });
    expect(nextRequestIdRef.current).toBe(1);

    bridge.post({ points: [{ x: 4, y: 5, z: 6 }] });
    expect(nextRequestIdRef.current).toBe(2);

    bridge.terminate();
  });

  it("post() skips empty chunks without calling postMessage", () => {
    const stub = new StubWorker();
    const nextRequestIdRef = { current: 0 };
    const bridge = new WorkerBridge(stub as unknown as Worker, () => {}, nextRequestIdRef);

    bridge.post({ points: [] });

    expect(stub.postMessageCalls).toHaveLength(0);
    bridge.terminate();
  });

  it("coalesces queued chunks while a worker request is in flight", () => {
    const stub = new StubWorker();
    const nextRequestIdRef = { current: 0 };
    const bridge = new WorkerBridge(stub as unknown as Worker, () => {}, nextRequestIdRef);

    bridge.post({ points: [{ x: 1, y: 2, z: 3 }] });
    bridge.post({ points: [{ x: 4, y: 5, z: 6 }] });
    bridge.post({ points: [{ x: 7, y: 8, z: 9 }] });

    expect(stub.postMessageCalls).toHaveLength(1);

    stub.simulate({
      type: "PREPROCESSED",
      requestId: 0,
      xyz: new Float32Array([1, 2, 3]),
      attributes: undefined,
      count: 1,
      rangeHints: {},
    });

    expect(stub.postMessageCalls).toHaveLength(2);
    const queued = stub.postMessageCalls[1].data as { requestId: number; points: unknown[] };
    expect(queued.requestId).toBe(2);
    expect(queued.points).toHaveLength(2);
    bridge.terminate();
  });

  it("reset drops stale in-flight responses and clears queue", () => {
    const stub = new StubWorker();
    const received: number[] = [];
    const nextRequestIdRef = { current: 0 };
    const bridge = new WorkerBridge(stub as unknown as Worker, (_xyz, _attributes, _count, requestId) => {
      received.push(requestId);
    }, nextRequestIdRef);

    bridge.post({ points: [{ x: 1, y: 1, z: 1 }] });
    bridge.post({ points: [{ x: 2, y: 2, z: 2 }] });
    bridge.reset(nextRequestIdRef.current);

    stub.simulate({
      type: "PREPROCESSED",
      requestId: 0,
      xyz: new Float32Array([1, 1, 1]),
      attributes: undefined,
      count: 1,
      rangeHints: {},
    });

    expect(received).toHaveLength(0);
    expect(stub.postMessageCalls).toHaveLength(1);
    bridge.terminate();
  });

  it("emits overflow drop telemetry when queue is saturated", () => {
    const stub = new StubWorker();
    const nextRequestIdRef = { current: 0 };
    const events: string[] = [];
    const bridge = new WorkerBridge(
      stub as unknown as Worker,
      () => {},
      nextRequestIdRef,
      false,
      {
        maxQueued: 1,
        maxCoalescePoints: 2,
        onQueueEvent: (event) => events.push(event.phase),
      },
    );

    bridge.post({ points: [{ x: 1, y: 1, z: 1 }] });
    bridge.post({ points: [{ x: 2, y: 2, z: 2 }] });
    bridge.post({ points: [{ x: 3, y: 3, z: 3 }, { x: 4, y: 4, z: 4 }] });

    expect(events).toContain("overflow_dropped_oldest");
    bridge.terminate();
  });
});
