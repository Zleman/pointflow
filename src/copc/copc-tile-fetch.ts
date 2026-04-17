import type { CopcNode } from "./copc-types";

export async function fetchTileBytes(params: {
  node: CopcNode;
  url: string;
  fullFileBuffer: ArrayBuffer | null;
  signal?: AbortSignal;
}): Promise<ArrayBuffer | null> {
  const { node, url, fullFileBuffer, signal } = params;
  const offset = Number(node.offset);
  const byteSize = Number(node.byteSize);
  if (byteSize <= 0) return null;

  if (fullFileBuffer) {
    const end = offset + byteSize;
    if (end > fullFileBuffer.byteLength) return null;
    return fullFileBuffer.slice(offset, end);
  }

  const res = await fetch(url, {
    headers: { Range: `bytes=${offset}-${offset + byteSize - 1}` },
    signal,
  });
  if (!res.ok && res.status !== 206) return null;
  return res.arrayBuffer();
}
