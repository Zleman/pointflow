/**
 * M11.2b — SSE adapter acceptance tests.
 *
 * Coverage:
 *   1. Calls onChunk for valid PointChunk events.
 *   2. Calls onError for malformed JSON.
 *   3. Calls onError for valid JSON that doesn't match PointChunk shape.
 *   4. Cleanup closes the EventSource.
 */

import { describe, it, expect, vi } from "vitest";
import { createSSEAdapter } from "../src/transport/sse-adapter";

// Minimal EventSource mock
function makeEsMock() {
  let messageHandler: ((e: MessageEvent) => void) | null = null;
  let errorHandler:   (() => void) | null = null;
  let closed = false;
  return {
    set onmessage(fn: (e: MessageEvent) => void) { messageHandler = fn; },
    set onerror(fn: () => void)                  { errorHandler = fn; },
    close() { closed = true; },
    emit(data: string) {
      messageHandler?.({ data } as MessageEvent);
    },
    emitError() { errorHandler?.(); },
    get closed()  { return closed; },
  };
}

function patchEventSource(mock: ReturnType<typeof makeEsMock>) {
  const orig = (globalThis as Record<string, unknown>)["EventSource"];
  (globalThis as Record<string, unknown>)["EventSource"] = function() { return mock; };
  return () => { (globalThis as Record<string, unknown>)["EventSource"] = orig; };
}

describe("M11.2b — SSE adapter", () => {

  it("calls onChunk for a valid PointChunk event", () => {
    const mock    = makeEsMock();
    const restore = patchEventSource(mock);
    const chunks: unknown[] = [];

    createSSEAdapter("/points", (c) => chunks.push(c));

    mock.emit(JSON.stringify({
      points: [{ x: 1, y: 2, z: 3, attributes: {} }],
    }));

    expect(chunks).toHaveLength(1);
    restore();
  });

  it("calls onError for malformed JSON", () => {
    const mock    = makeEsMock();
    const restore = patchEventSource(mock);
    const errors: Error[] = [];

    createSSEAdapter("/points", () => {}, (e) => errors.push(e));
    mock.emit("not-json{{{");

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("parse");
    restore();
  });

  it("calls onError when JSON doesn't match PointChunk shape", () => {
    const mock    = makeEsMock();
    const restore = patchEventSource(mock);
    const errors: Error[] = [];

    createSSEAdapter("/points", () => {}, (e) => errors.push(e));
    mock.emit(JSON.stringify({ type: "status", value: 42 }));

    expect(errors).toHaveLength(1);
    restore();
  });

  it("closes EventSource on cleanup", () => {
    const mock    = makeEsMock();
    const restore = patchEventSource(mock);

    const stop = createSSEAdapter("/points", () => {});
    expect(mock.closed).toBe(false);
    stop();
    expect(mock.closed).toBe(true);
    restore();
  });
});
