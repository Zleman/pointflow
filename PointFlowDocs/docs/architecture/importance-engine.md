---
id: importance-engine
title: Importance engine
sidebar_position: 3
---

# Importance engine

The importance engine is the model that assigns a score to each point and uses that score to decide both which points survive buffer evictions and which points get drawn on each frame.

## The score function

```
score(p) = importance(p) × recency(p)
```

Both factors are in the range [0, 1]. The product is also in [0, 1].

### Importance

`importance(p)` is the normalized value of the attribute you designate as the importance field. If you set `importanceField="uncertainty"` and a point has `uncertainty=0.8`, its importance is 0.8. If no importance field is configured, `importance(p) = 1.0` for all points.

### Recency

`recency(p)` is an exponential decay based on how long ago the point was ingested:

```
recency(p) = 0.5 ^ (age_ms / maxStalenessMs)
```

A point at age `maxStalenessMs` has recency 0.5. At `2 × maxStalenessMs`, it's 0.25. At age 0 (just ingested), it's 1.0.

If `maxStalenessMs` is 0 (the default), recency is 1.0 for all points.

## K=16 eviction

When the buffer is full and needs to evict, it scans the 16 oldest slots and evicts the one with the lowest score:

```
evict = min(score, over 16 oldest slots)
```

This is the "K=16 lookahead" strategy. The implementation:

1. Start at the current write head (the oldest slot in FIFO terms).
2. Scan forward by 16 slots (wrapping around if needed).
3. Among those 16, evict the one with the lowest score.

Cost: O(16) per eviction. Constant, regardless of buffer size. The only state needed is the current write head.

When importance and staleness are both off (the default), all 16 slots have score 1.0, so `worstOffset = 0` always and the first slot gets evicted. This is identical to FIFO with no overhead.

## GPU stochastic sampling

On the WebGPU path, the compute shader uses importance scores to decide which points get drawn each frame:

1. For each point, compute a per-point PCG hash using the point index and a frame seed.
2. If `hash < importance(p)`, the point passes to the output buffer. Otherwise it doesn't.
3. A point with importance 1.0 always passes. A point with importance 0.1 passes roughly 10% of frames.

The frame seed is quantized to 500 ms intervals to prevent strobing at 60 Hz. Points don't flicker on every frame, they transition smoothly.

## Measured performance

From the benchmark suite:

| Guarantee | Threshold | Result |
|---|---|---|
| High-importance retention under sustained pressure | ≥ 70% vs 50% FIFO | Pass |
| Density ratio (high vs low regions) | ≥ 5x | Pass |
| FPS / p95 regression with importance on | ≤ 5% | Pass |
| Stale-high evicted before fresh-low | Stale avg < no-staleness avg - 0.20 | Pass |
| Uniform importance = identical FIFO | Exact match | Pass |

The last row matters: if you add `importanceField` but your data has uniform importance values, you pay no overhead and get exactly FIFO behavior.

## Design rationale

The unified function across eviction and sampling is a deliberate choice. If eviction and sampling used different scoring functions, you could end up with a high-importance point that survives eviction but draws rarely. That's incoherent behavior and would confuse anyone tuning the system.

Using one function means: the point that survives longest is also the point that renders most often. The renderer and the buffer agree on what "important" means.

K=16 is chosen to balance retention quality against cost. K=1 is FIFO. K=N is optimal retention at O(N) cost per eviction. K=16 gives nearly the same retention benefit as higher K values in practice, because importance is usually distributed such that a very low-scoring slot appears within the first 16 candidates.
