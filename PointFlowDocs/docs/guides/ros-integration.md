---
id: ros-integration
title: ROS integration
sidebar_position: 11
---

# ROS integration

`createRosbridgeAdapter` connects to a rosbridge v2 WebSocket server and translates `sensor_msgs/PointCloud2` messages into PointFlow chunks.

## Prerequisites

Your ROS stack needs [rosbridge_suite](https://github.com/RobotWebTools/rosbridge_suite) running. The default port is 9090.

```bash
# ROS 2
ros2 launch rosbridge_server rosbridge_websocket_launch.xml
```

## Basic usage

```ts
import { createRosbridgeAdapter } from "pointflow";

const stop = createRosbridgeAdapter(
  "ws://robot:9090",
  "/velodyne_points",
  {
    fields: {
      intensity: "intensity",
      ring: "ring",
    },
    onChunk: (chunk) => api.current?.pushChunk(chunk),
    onError: (e) => console.error("rosbridge error:", e),
  },
);

// Later — unsubscribes and closes the socket
stop();
```

The `fields` map translates ROS field names (from the `PointCloud2.fields` array) to PointFlow attribute keys. `x`, `y`, `z` are always extracted automatically and don't need to be mapped.

## Using it in a component

```tsx
import { useEffect, useRef } from "react";
import { StreamedPointCloud, type StreamedPointCloudRef } from "pointflow";
import { createRosbridgeAdapter } from "pointflow";

export function RosScene() {
  const api = useRef<StreamedPointCloudRef>(null);

  useEffect(() => {
    const stop = createRosbridgeAdapter(
      "ws://localhost:9090",
      "/scan",
      {
        fields: { intensity: "intensity" },
        onChunk: (chunk) => api.current?.pushChunk(chunk),
      },
    );
    return stop;
  }, []);

  return (
    <StreamedPointCloud
      maxPoints={500_000}
      colorBy="intensity"
      workerMode={true}
      onReady={(ref) => { api.current = ref; }}
    />
  );
}
```

## Field mapping

A `sensor_msgs/PointCloud2` message has a `fields` array that describes the layout of each point in the binary data. PointFlow extracts x, y, z automatically. You map other fields by their ROS name:

```ts
fields: {
  "intensity":      "intensity",       // ROS field "intensity" → PointFlow attribute "intensity"
  "ring":           "ring",
  "time":           "timestamp",       // rename if you want
  "classification": "label",
}
```

Any ROS fields not in the map are ignored.

## Connection lifecycle

The adapter opens the WebSocket, sends a rosbridge subscription message, and starts calling `onChunk` for each incoming message. When you call `stop()`, it sends an unsubscribe message and closes the socket.

If the connection drops unexpectedly, `onError` fires. You're responsible for reconnection logic if you need it:

```ts
function connect() {
  const stop = createRosbridgeAdapter(ws, topic, {
    onChunk: ...,
    onError: () => {
      stop();
      setTimeout(connect, 2000);  // retry after 2 seconds
    },
  });
}
connect();
```

## Performance notes

`sensor_msgs/PointCloud2` can carry large payloads. Velodyne VLP-16 at 10 Hz sends ~30,000 points per scan. HDL-64 sends ~130,000. For these rates, enable worker mode and consider worker-side culling if you're only interested in the current field of view:

```tsx
<StreamedPointCloud
  maxPoints={200_000}
  workerMode={true}
  workerCulling={true}
/>
```
