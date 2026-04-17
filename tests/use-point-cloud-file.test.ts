/**
 * Tests for File/Blob support and race-safety in usePointCloud.
 *
 * Strategy: mock URL.createObjectURL / URL.revokeObjectURL and a fake loader
 * worker, then drive the hook's useEffect via renderHook/rerender.
 *
 * Tests cover:
 *   - string URL passes through unchanged (no object URL created)
 *   - File  source creates an object URL and passes it to the worker
 *   - Blob  source creates an object URL and passes it to the worker
 *   - cleanup revokes the object URL after unmount
 *   - string URL cleanup does NOT call revokeObjectURL
 *   - null/undefined src stays idle (no regression)
 *   - swap-under-load: stale CHUNK/DONE from old worker are dropped
 *   - abort() terminates worker, resets to idle, revokes blob URL
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { usePointCloud } from "../src/hooks/usePointCloud";

// ── Fake worker ───────────────────────────────────────────────────────────────

function makeFakeWorker() {
  const messages: unknown[] = [];
  return {
    postMessage: vi.fn((msg: unknown) => messages.push(msg)),
    terminate:   vi.fn(),
    onmessage:   null as ((e: MessageEvent) => void) | null,
    onerror:     null as ((e: ErrorEvent) => void) | null,
    _messages:   messages,
  };
}

// ── URL mock ──────────────────────────────────────────────────────────────────

const FAKE_OBJECT_URL = "blob:null/fake-uuid-1234";

beforeEach(() => {
  vi.stubGlobal("URL", {
    createObjectURL: vi.fn(() => FAKE_OBJECT_URL),
    revokeObjectURL: vi.fn(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeLoaderFactory(worker: ReturnType<typeof makeFakeWorker>) {
  return () => worker as unknown as Worker;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("usePointCloud — string URL (regression)", () => {
  it("passes the string URL directly to the worker without createObjectURL", () => {
    const worker = makeFakeWorker();
    const { unmount } = renderHook(() =>
      usePointCloud("/scan.ply", { loaderFactory: makeLoaderFactory(worker) })
    );

    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(worker.postMessage).toHaveBeenCalledOnce();
    const msg = worker.postMessage.mock.calls[0][0] as { url: string };
    expect(msg.url).toBe("/scan.ply");

    unmount();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });

  it("terminates the worker on unmount", () => {
    const worker = makeFakeWorker();
    const { unmount } = renderHook(() =>
      usePointCloud("/scan.ply", { loaderFactory: makeLoaderFactory(worker) })
    );
    unmount();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});

describe("usePointCloud — File source", () => {
  it("creates an object URL from the File and passes it to the worker", () => {
    const file = new File(["dummy content"], "scan.ply", { type: "application/octet-stream" });
    const worker = makeFakeWorker();

    renderHook(() =>
      usePointCloud(file, { loaderFactory: makeLoaderFactory(worker) })
    );

    expect(URL.createObjectURL).toHaveBeenCalledOnce();
    expect(URL.createObjectURL).toHaveBeenCalledWith(file);

    expect(worker.postMessage).toHaveBeenCalledOnce();
    const msg = worker.postMessage.mock.calls[0][0] as { url: string };
    expect(msg.url).toBe(FAKE_OBJECT_URL);
  });

  it("revokes the object URL on unmount", () => {
    const file = new File(["dummy"], "scan.ply");
    const worker = makeFakeWorker();

    const { unmount } = renderHook(() =>
      usePointCloud(file, { loaderFactory: makeLoaderFactory(worker) })
    );

    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(FAKE_OBJECT_URL);
  });

  it("initial status is 'loading' when a File is provided", () => {
    const file = new File(["dummy"], "scan.ply");
    const worker = makeFakeWorker();

    const { result } = renderHook(() =>
      usePointCloud(file, { loaderFactory: makeLoaderFactory(worker) })
    );

    expect(result.current.status).toBe("loading");
  });
});

describe("usePointCloud — Blob source", () => {
  it("creates an object URL from the Blob and passes it to the worker", () => {
    const blob = new Blob(["dummy content"], { type: "application/octet-stream" });
    const worker = makeFakeWorker();

    renderHook(() =>
      usePointCloud(blob, { loaderFactory: makeLoaderFactory(worker) })
    );

    expect(URL.createObjectURL).toHaveBeenCalledOnce();
    expect(URL.createObjectURL).toHaveBeenCalledWith(blob);

    const msg = worker.postMessage.mock.calls[0][0] as { url: string };
    expect(msg.url).toBe(FAKE_OBJECT_URL);
  });

  it("revokes the Blob URL on unmount", () => {
    const blob = new Blob(["dummy"]);
    const worker = makeFakeWorker();

    const { unmount } = renderHook(() =>
      usePointCloud(blob, { loaderFactory: makeLoaderFactory(worker) })
    );

    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(FAKE_OBJECT_URL);
  });
});

describe("usePointCloud — null/undefined src", () => {
  it("stays idle and does not spawn a worker when src is null", () => {
    const worker = makeFakeWorker();
    const { result } = renderHook(() =>
      usePointCloud(null, { loaderFactory: makeLoaderFactory(worker) })
    );

    expect(result.current.status).toBe("idle");
    expect(worker.postMessage).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("stays idle when src is undefined", () => {
    const worker = makeFakeWorker();
    const { result } = renderHook(() =>
      usePointCloud(undefined, { loaderFactory: makeLoaderFactory(worker) })
    );

    expect(result.current.status).toBe("idle");
    expect(worker.postMessage).not.toHaveBeenCalled();
  });
});

describe("usePointCloud — TS type signature", () => {
  it("accepts File, Blob, string, null, and undefined without TS error", async () => {
    const mod = await import("../src/hooks/usePointCloud");
    type Src = Parameters<typeof mod.usePointCloud>[0];
    // These assignments would fail tsc if the type were string-only.
    const _a: Src = "/url.ply";
    const _b: Src = new File([], "f.ply");
    const _c: Src = new Blob([]);
    const _d: Src = null;
    const _e: Src = undefined;
    expect([_a, _b, _c, _d, _e]).toHaveLength(5);
  });

  it("exposes abort() in the return type", async () => {
    const mod = await import("../src/hooks/usePointCloud");
    type Result = ReturnType<typeof mod.usePointCloud>;
    const _: Result["abort"] = () => {};
    expect(typeof _).toBe("function");
  });
});

// ── Swap-under-load (race safety) ─────────────────────────────────────────────

describe("usePointCloud — swap-under-load (stale message protection)", () => {
  it("drops CHUNK from old worker after src changes to a new file", () => {
    const workers: ReturnType<typeof makeFakeWorker>[] = [];
    const loaderFactory = () => {
      const w = makeFakeWorker();
      workers.push(w);
      return w as unknown as Worker;
    };

    const fileA = new File(["a"], "a.ply");
    const fileB = new File(["b"], "b.ply");

    const { result, rerender } = renderHook(
      ({ src }: { src: File }) => usePointCloud(src, { loaderFactory }),
      { initialProps: { src: fileA } },
    );

    // workerA is running, fileA is loading.
    expect(workers).toHaveLength(1);
    const workerA = workers[0];

    // Switch src to fileB — workerA is terminated, workerB starts.
    rerender({ src: fileB });
    expect(workers).toHaveLength(2);

    // Simulate a stale CHUNK arriving from workerA after it was "terminated".
    act(() => {
      workerA.onmessage?.({
        data: {
          type: "CHUNK",
          xyz: new Float32Array([1, 2, 3]),
          attributes: [],
          count: 1,
          progress: 0.9,
        },
      } as MessageEvent);
    });

    // Progress should still be 0 — the stale chunk must not advance it.
    expect(result.current.progress).toBe(0);
  });

  it("drops DONE from old worker — status stays 'loading' not 'ready'", () => {
    const workers: ReturnType<typeof makeFakeWorker>[] = [];
    const loaderFactory = () => {
      const w = makeFakeWorker();
      workers.push(w);
      return w as unknown as Worker;
    };

    const fileA = new File(["a"], "a.ply");
    const fileB = new File(["b"], "b.ply");

    const { result, rerender } = renderHook(
      ({ src }: { src: File }) => usePointCloud(src, { loaderFactory }),
      { initialProps: { src: fileA } },
    );

    const workerA = workers[0];
    rerender({ src: fileB });

    // Fire stale DONE from workerA.
    act(() => {
      workerA.onmessage?.({ data: { type: "DONE" } } as MessageEvent);
    });

    // status must still be 'loading' (fileB worker hasn't finished).
    expect(result.current.status).toBe("loading");
  });

  it("DONE from the new worker sets status to 'ready'", () => {
    const workers: ReturnType<typeof makeFakeWorker>[] = [];
    const loaderFactory = () => {
      const w = makeFakeWorker();
      workers.push(w);
      return w as unknown as Worker;
    };

    const fileA = new File(["a"], "a.ply");
    const fileB = new File(["b"], "b.ply");

    const { result, rerender } = renderHook(
      ({ src }: { src: File }) => usePointCloud(src, { loaderFactory }),
      { initialProps: { src: fileA } },
    );

    rerender({ src: fileB });
    const workerB = workers[1];

    act(() => {
      workerB.onmessage?.({ data: { type: "DONE" } } as MessageEvent);
    });

    expect(result.current.status).toBe("ready");
  });

  it("terminates the old worker when src changes", () => {
    const workers: ReturnType<typeof makeFakeWorker>[] = [];
    const loaderFactory = () => {
      const w = makeFakeWorker();
      workers.push(w);
      return w as unknown as Worker;
    };

    const fileA = new File(["a"], "a.ply");
    const fileB = new File(["b"], "b.ply");

    const { rerender } = renderHook(
      ({ src }: { src: File }) => usePointCloud(src, { loaderFactory }),
      { initialProps: { src: fileA } },
    );

    const workerA = workers[0];
    rerender({ src: fileB });

    expect(workerA.terminate).toHaveBeenCalledOnce();
  });
});

// ── abort() ───────────────────────────────────────────────────────────────────

describe("usePointCloud — abort()", () => {
  it("terminates the in-flight worker", () => {
    const worker = makeFakeWorker();
    const { result } = renderHook(() =>
      usePointCloud("/scan.ply", { loaderFactory: makeLoaderFactory(worker) }),
    );

    act(() => result.current.abort());
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("resets status to 'idle' immediately", () => {
    const worker = makeFakeWorker();
    const { result } = renderHook(() =>
      usePointCloud("/scan.ply", { loaderFactory: makeLoaderFactory(worker) }),
    );

    expect(result.current.status).toBe("loading");
    act(() => result.current.abort());
    expect(result.current.status).toBe("idle");
  });

  it("resets progress to 0", () => {
    const worker = makeFakeWorker();
    const { result } = renderHook(() =>
      usePointCloud("/scan.ply", { loaderFactory: makeLoaderFactory(worker) }),
    );

    // Advance progress via a fake CHUNK.
    act(() => {
      worker.onmessage?.({
        data: { type: "CHUNK", xyz: new Float32Array(3), attributes: [], count: 1, progress: 0.5 },
      } as MessageEvent);
    });
    expect(result.current.progress).toBe(0.5);

    act(() => result.current.abort());
    expect(result.current.progress).toBe(0);
  });

  it("prevents subsequent worker messages from updating state", () => {
    const worker = makeFakeWorker();
    const { result } = renderHook(() =>
      usePointCloud("/scan.ply", { loaderFactory: makeLoaderFactory(worker) }),
    );

    act(() => result.current.abort());

    // Send DONE from the now-aborted worker.
    act(() => {
      worker.onmessage?.({ data: { type: "DONE" } } as MessageEvent);
    });

    // Must remain 'idle', not 'ready'.
    expect(result.current.status).toBe("idle");
  });

  it("revokes object URL when aborting a File/Blob load", () => {
    const file = new File(["data"], "scan.ply");
    const worker = makeFakeWorker();
    const { result } = renderHook(() =>
      usePointCloud(file, { loaderFactory: makeLoaderFactory(worker) }),
    );

    act(() => result.current.abort());
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(FAKE_OBJECT_URL);
  });

  it("does not call revokeObjectURL when aborting a string URL load", () => {
    const worker = makeFakeWorker();
    const { result } = renderHook(() =>
      usePointCloud("/scan.ply", { loaderFactory: makeLoaderFactory(worker) }),
    );

    act(() => result.current.abort());
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });

  it("does not double-revoke when abort() is followed by unmount", () => {
    const file = new File(["data"], "scan.ply");
    const worker = makeFakeWorker();
    const { result, unmount } = renderHook(() =>
      usePointCloud(file, { loaderFactory: makeLoaderFactory(worker) }),
    );

    act(() => result.current.abort());
    unmount();

    // revokeObjectURL should be called exactly once.
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when called with no active load (null src)", () => {
    const worker = makeFakeWorker();
    const { result } = renderHook(() =>
      usePointCloud(null, { loaderFactory: makeLoaderFactory(worker) }),
    );

    expect(() => act(() => result.current.abort())).not.toThrow();
    expect(result.current.status).toBe("idle");
  });

  it("stays stable over repeated abort-and-remount cycles", () => {
    const file = new File(["data"], "scan.ply");
    for (let i = 0; i < 10; i++) {
      const worker = makeFakeWorker();
      const { result, unmount } = renderHook(() =>
        usePointCloud(file, { loaderFactory: makeLoaderFactory(worker) }),
      );
      act(() => result.current.abort());
      expect(result.current.status).toBe("idle");
      unmount();
    }
  });
});
