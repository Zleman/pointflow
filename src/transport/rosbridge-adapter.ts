/**
 * ROS / rosbridge WebSocket adapter.
 *
 * Subscribes to a ROS topic via the rosbridge v2 JSON protocol and translates
 * `sensor_msgs/PointCloud2` messages into PointFlow PointChunk objects.
 *
 * Usage:
 *   const stop = createRosbridgeAdapter(
 *     "ws://robot:9090",
 *     "/velodyne_points",
 *     {
 *       fields: { intensity: "intensity", label: "classification" },
 *       onChunk: (chunk) => api.current?.pushChunk(chunk),
 *       onError: (e) => console.error(e),
 *     }
 *   );
 *   // later:
 *   stop(); // unsubscribes + closes socket
 *
 * Wire protocol: rosbridge v2 (https://github.com/RobotWebTools/rosbridge_suite)
 * Message type:  sensor_msgs/PointCloud2
 */

import type { PointChunk } from "../core/types";


/**
 * Maps ROS field names in the PointCloud2 `fields` array to PointFlow attribute
 * keys. Position fields (x, y, z) are always extracted and do not need mapping.
 *
 * Example: `{ intensity: "intensity", label: "classification" }`
 */
export type RosbridgeFieldMap = Record<string, string>;

export interface RosbridgeOptions {
  /**
   * Maps ROS field names → PointFlow attribute keys.
   * If omitted, only x/y/z are extracted.
   */
  fields?: RosbridgeFieldMap;
  /** Called for each decoded PointCloud2 frame. */
  onChunk: (chunk: PointChunk) => void;
  /** Called on WebSocket errors or malformed messages. */
  onError?: (error: Error) => void;
}


/** ROS datatype codes → byte width. */
const ROS_DATATYPE_WIDTH: Record<number, number> = {
  1: 1, // INT8
  2: 1, // UINT8
  3: 2, // INT16
  4: 2, // UINT16
  5: 4, // INT32
  6: 4, // UINT32
  7: 4, // FLOAT32
  8: 8, // FLOAT64
};

/** Read one scalar value from a DataView at `offset` using the ROS datatype code. */
function readRosField(
  view: DataView,
  offset: number,
  datatype: number,
  littleEndian: boolean,
): number {
  switch (datatype) {
    case 1:  return view.getInt8(offset);
    case 2:  return view.getUint8(offset);
    case 3:  return view.getInt16(offset, littleEndian);
    case 4:  return view.getUint16(offset, littleEndian);
    case 5:  return view.getInt32(offset, littleEndian);
    case 6:  return view.getUint32(offset, littleEndian);
    case 7:  return view.getFloat32(offset, littleEndian);
    case 8:  return view.getFloat64(offset, littleEndian);
    default: return 0;
  }
}


interface Ros2Field {
  name:     string;
  offset:   number;
  datatype: number;
}


function decodePointCloud2(
  msg: Record<string, unknown>,
  fieldMap: RosbridgeFieldMap,
): PointChunk | null {
  // Decode base64 data field
  const b64 = msg["data"] as string | undefined;
  if (!b64) return null;

  let binary: Uint8Array;
  try {
    const raw = atob(b64);
    binary    = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) binary[i] = raw.charCodeAt(i);
  } catch {
    return null;
  }

  const pointStep    = (msg["point_step"]   as number) | 0;
  const width        = (msg["width"]        as number) | 0;
  const height       = (msg["height"]       as number) | 0;
  const isBigEndian  = !!(msg["is_bigendian"] as boolean);
  const littleEndian = !isBigEndian;
  const N            = width * height;

  if (N === 0 || pointStep === 0) return null;

  // Parse field descriptors
  const rosFields = (msg["fields"] as Ros2Field[]) ?? [];
  const byName    = new Map<string, Ros2Field>();
  for (const f of rosFields) byName.set(f.name, f);

  const xField = byName.get("x");
  const yField = byName.get("y");
  const zField = byName.get("z");
  if (!xField || !yField || !zField) return null;

  // Build list of extra fields to extract
  const extraFields: Array<{ rosField: Ros2Field; attrKey: string }> = [];
  for (const [rosName, attrKey] of Object.entries(fieldMap)) {
    const f = byName.get(rosName);
    if (f) extraFields.push({ rosField: f, attrKey });
  }

  const view   = new DataView(binary.buffer, binary.byteOffset, binary.byteLength);
  const points = [];

  for (let i = 0; i < N; i++) {
    const base = i * pointStep;
    if (base + pointStep > binary.byteLength) break;

    const x = readRosField(view, base + xField.offset, xField.datatype, littleEndian);
    const y = readRosField(view, base + yField.offset, yField.datatype, littleEndian);
    const z = readRosField(view, base + zField.offset, zField.datatype, littleEndian);

    // Skip NaN / Inf points (common in sparse LiDAR scans)
    if (!isFinite(x) || !isFinite(y) || !isFinite(z)) continue;

    const attributes: Record<string, number> = {};
    for (const { rosField, attrKey } of extraFields) {
      attributes[attrKey] = readRosField(view, base + rosField.offset, rosField.datatype, littleEndian);
    }

    points.push({ x, y, z, attributes });
  }

  return { points };
}


/**
 * Connect to a rosbridge WebSocket server and subscribe to a PointCloud2 topic.
 *
 * @param url     rosbridge WebSocket URL, e.g. `"ws://robot:9090"`.
 * @param topic   ROS topic name, e.g. `"/velodyne_points"`.
 * @param options Decoding options and callbacks.
 * @returns       Cleanup function — unsubscribes and closes the socket.
 */
export function createRosbridgeAdapter(
  url: string,
  topic: string,
  options: RosbridgeOptions,
): () => void {
  const { fields = {}, onChunk, onError } = options;
  const ws = new WebSocket(url);

  ws.onopen = () => {
    ws.send(JSON.stringify({
      op:    "subscribe",
      topic,
      type:  "sensor_msgs/PointCloud2",
    }));
  };

  ws.onmessage = (event: MessageEvent) => {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(event.data as string) as Record<string, unknown>;
    } catch {
      return;
    }
    if (parsed["op"] !== "publish" || parsed["topic"] !== topic) return;

    const msg = parsed["msg"] as Record<string, unknown> | undefined;
    if (!msg) return;

    const chunk = decodePointCloud2(msg, fields);
    if (chunk) onChunk(chunk);
    else onError?.(new Error("[rosbridge] Failed to decode PointCloud2 message"));
  };

  ws.onerror = () => {
    onError?.(new Error(`[rosbridge] WebSocket error on ${url}`));
  };

  return () => {
    try {
      ws.send(JSON.stringify({ op: "unsubscribe", topic }));
    } catch { /* ignore if already closing */ }
    ws.close();
  };
}

// suppress unused-variable warning for the width table (it documents the protocol)
void ROS_DATATYPE_WIDTH;
