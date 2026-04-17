import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createWebSocketAdapter } from "../src/transport/websocket-adapter";
import type { PointChunk } from "../src/core/types";

describe("createWebSocketAdapter", () => {
  let mockClose: ReturnType<typeof vi.fn>;
  let mockOnMessage: ((event: MessageEvent) => void) | null;

  beforeEach(() => {
    mockClose = vi.fn();
    mockOnMessage = null;
    vi.stubGlobal("WebSocket", vi.fn((_url: string) => {
      const ws = {
        close: mockClose,
        get onmessage() {
          return mockOnMessage;
        },
        set onmessage(handler: (event: MessageEvent) => void) {
          mockOnMessage = handler;
        }
      };
      return ws;
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calling the returned cleanup function closes the socket", () => {
    const disconnect = createWebSocketAdapter("ws://test", () => {});
    expect(mockClose).not.toHaveBeenCalled();
    disconnect();
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it("a valid JSON message calls onChunk with the parsed chunk", () => {
    const chunk: PointChunk = {
      points: [{ x: 1, y: 2, z: 3 }]
    };
    const onChunk = vi.fn();
    createWebSocketAdapter("ws://test", onChunk);
    expect(mockOnMessage).not.toBeNull();
    mockOnMessage!({
      data: JSON.stringify(chunk)
    } as MessageEvent);
    expect(onChunk).toHaveBeenCalledTimes(1);
    expect(onChunk).toHaveBeenCalledWith(chunk);
  });

  it("a malformed JSON message does not call onChunk and does not throw", () => {
    const onChunk = vi.fn();
    createWebSocketAdapter("ws://test", onChunk);
    expect(mockOnMessage).not.toBeNull();
    expect(() => {
      mockOnMessage!({ data: "not json {" } as MessageEvent);
    }).not.toThrow();
    expect(onChunk).not.toHaveBeenCalled();
  });
});
