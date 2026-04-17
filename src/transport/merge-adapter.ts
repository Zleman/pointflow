import type { PointChunk } from "../core/types";

export type ChunkEmitter = (chunk: PointChunk) => void;
export type ChunkUnsubscribe = () => void;
export type ChunkSourceFactory = (emit: ChunkEmitter) => ChunkUnsubscribe;

export function withSourceTag(sourceId: string, emit: ChunkEmitter): ChunkEmitter {
  return (chunk: PointChunk) => {
    emit({
      ...chunk,
      sourceId: chunk.sourceId ?? sourceId,
      receivedAt: chunk.receivedAt ?? Date.now(),
    });
  };
}

export function mergeChunkStreams(sources: ChunkSourceFactory[], emit: ChunkEmitter): ChunkUnsubscribe {
  const stops = sources.map((source, index) => source(withSourceTag(`source-${index + 1}`, emit)));
  return () => {
    for (const stop of stops) stop();
  };
}
