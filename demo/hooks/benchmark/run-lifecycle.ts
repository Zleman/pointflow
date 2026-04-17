export interface RunAggregate {
  samples: number;
  frameTimeSumMs: number;
  hitches50: number;
  hitches100: number;
  rollingP95Ms: number;
  maxHeapMb: number;
  maxDroppedRatio: number;
  peakIngestRate: number;
  peakRenderedPoints: number;
  minFps: number;
  maxFps: number;
}

export function createInitialRunAggregate(): RunAggregate {
  return {
    samples: 0,
    frameTimeSumMs: 0,
    hitches50: 0,
    hitches100: 0,
    rollingP95Ms: 0,
    maxHeapMb: 0,
    maxDroppedRatio: 0,
    peakIngestRate: 0,
    peakRenderedPoints: 0,
    minFps: Number.POSITIVE_INFINITY,
    maxFps: 0,
  };
}
