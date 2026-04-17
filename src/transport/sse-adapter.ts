/**
 * Server-Sent Events (SSE) adapter.
 *
 * Consumes a `text/event-stream` endpoint where each event carries a
 * JSON-encoded PointChunk body. Useful for simple server stacks (Flask,
 * FastAPI, Express) that don't need a WebSocket connection.
 *
 * Server-side example (Python / Flask):
 *   @app.route("/points")
 *   def stream():
 *       def generate():
 *           while True:
 *               chunk = {"points": get_latest_points()}
 *               yield f"data: {json.dumps(chunk)}\n\n"
 *       return Response(generate(), mimetype="text/event-stream")
 *
 * Client-side:
 *   const stop = createSSEAdapter("/points", (chunk) => api.current?.pushChunk(chunk));
 *   // later:
 *   stop(); // closes the EventSource connection
 */

import type { PointChunk, PointRecord } from "../core/types";


function isPointRecord(v: unknown): v is PointRecord {
  return (
    typeof v === "object" && v !== null &&
    typeof (v as PointRecord).x === "number" &&
    typeof (v as PointRecord).y === "number" &&
    typeof (v as PointRecord).z === "number"
  );
}

function isPointChunk(v: unknown): v is PointChunk {
  return (
    typeof v === "object" && v !== null &&
    "points" in v &&
    Array.isArray((v as PointChunk).points) &&
    (v as PointChunk).points.every(isPointRecord)
  );
}


/**
 * Open a Server-Sent Events connection and call `onChunk` for each received
 * PointChunk event.
 *
 * @param url      SSE endpoint URL.
 * @param onChunk  Called for each successfully decoded PointChunk event.
 * @param onError  Called on EventSource errors or malformed data.
 * @returns        Cleanup function — closes the EventSource.
 */
export function createSSEAdapter(
  url: string,
  onChunk: (chunk: PointChunk) => void,
  onError?: (error: Error) => void,
): () => void {
  const es = new EventSource(url);

  es.onmessage = (event: MessageEvent) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.data as string);
    } catch {
      onError?.(new Error(`[SSE] Failed to parse event data: ${String(event.data).slice(0, 80)}`));
      return;
    }

    if (!isPointChunk(parsed)) {
      onError?.(new Error("[SSE] Event data does not match PointChunk shape"));
      return;
    }

    onChunk(parsed);
  };

  es.onerror = () => {
    onError?.(new Error(`[SSE] Connection error on ${url}`));
  };

  return () => es.close();
}
