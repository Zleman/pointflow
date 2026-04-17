import type { PointChunk } from "../core/types";

function isPointChunk(value: unknown): value is PointChunk {
  return (
    typeof value === "object" &&
    value !== null &&
    "points" in value &&
    Array.isArray((value as PointChunk).points)
  );
}

export function createWebSocketAdapter(
  url: string,
  onChunk: (chunk: PointChunk) => void,
  onError?: (event: Event) => void,
): () => void {
  const ws = new WebSocket(url);

  ws.onmessage = (event: MessageEvent) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.data as string);
    } catch {
      return;
    }
    if (!isPointChunk(parsed)) return;
    onChunk(parsed);
  };

  if (onError) {
    ws.onerror = onError;
  }

  return () => {
    ws.close();
  };
}
