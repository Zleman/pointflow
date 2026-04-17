---
id: quantized-transport
title: Quantized transport
sidebar_position: 6
---

# Quantized transport

`createQuantizedAdapter` decodes compact binary WebSocket messages where each point occupies 6 bytes instead of 12. That's half the XYZ wire cost at sub-millimetre precision over typical scan ranges.

## When to use it

Use quantized transport when:

- You're streaming at high rate (thousands of points per second or more) and bandwidth matters.
- Your server can encode point data in the quantized binary format.
- You need low latency and can't afford JSON parsing overhead.

For low-rate feeds or when server-side encoding isn't practical, the JSON WebSocket adapter is simpler and perfectly fine.

## Wire format

```
[uint16 N][uint8 M][uint8 flags][float32 xMin][float32 yMin][float32 zMin][float32 scale]
  N × { uint16 qx, uint16 qy, uint16 qz }
  N × M × uint16  (attribute values, row-major)
```

All values are little-endian. `N` is the point count. `M` is the attribute channel count. `flags` is reserved for future use, set to 0.

Position reconstruction: `x = xMin + (qx / 65535) × scale`

Non-binary frames (JSON strings) on the same socket are silently ignored.

## Client-side setup

```ts
import { createQuantizedAdapter } from "pointflow";

const ws = new WebSocket("wss://lidar.example.com/binary-stream");

const stop = createQuantizedAdapter(
  ws,
  {
    attributes: [
      { key: "intensity",      min: 0,   max: 1   },
      { key: "classification", min: 0,   max: 31  },
    ],
  },
  (chunk) => api.current?.pushChunk(chunk),
);

// Later — detach listener, does NOT close the socket
stop();
```

The `attributes` array must match the server's channel order exactly. Each attribute is dequantized with `value = min + (uint16 / 65535) × (max - min)`.

## Server-side encoding (Python example)

```python
import struct

def encode_chunk(points, x_min, y_min, z_min, scale):
    n = len(points)
    header = struct.pack("<HBBffff", n, 1, 0, x_min, y_min, z_min, scale)
    xyz = b""
    attrs = b""
    for p in points:
        qx = int((p.x - x_min) / scale * 65535)
        qy = int((p.y - y_min) / scale * 65535)
        qz = int((p.z - z_min) / scale * 65535)
        qi = int(p.intensity * 65535)
        xyz += struct.pack("<HHH", qx, qy, qz)
        attrs += struct.pack("<H", qi)
    return header + xyz + attrs
```

## Precision

The uint16 range is 0–65535 (65,536 steps). Over a 100 m scan range, each step is ~1.5 mm. Over a 10 m range, each step is ~0.15 mm. For most LiDAR applications this is more than enough. If you need sub-0.1 mm precision over large ranges, use full float32 instead.
