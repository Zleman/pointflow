import type { RendererBackend, RuntimeMode } from "pointflow";
import type { MockStreamShape } from "./utils";

export const DEMO_MAX_POINTS_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 50_000, label: "50,000" },
  { value: 200_000, label: "200,000" },
  { value: 500_000, label: "500,000" },
  { value: 1_000_000, label: "1,000,000" },
];

export const DEMO_COMPARE_MAX_POINTS_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 50_000, label: "50,000" },
  { value: 200_000, label: "200,000" },
  { value: 500_000, label: "500,000" },
];

export const DEMO_BACKEND_OPTIONS: ReadonlyArray<{ value: RendererBackend; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "webgpu", label: "WebGPU" },
  { value: "webgl", label: "WebGL" },
];

export const DEMO_STREAM_COLOR_BY_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "velocity", label: "Velocity" },
  { value: "intensity", label: "Intensity" },
  { value: "temperature", label: "Temperature" },
  { value: "pressure", label: "Pressure" },
];

export const DEMO_COMPARE_COLOR_BY_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "velocity", label: "Velocity" },
  { value: "intensity", label: "Intensity" },
];

export const DEMO_STREAM_SHAPE_OPTIONS: ReadonlyArray<{ value: MockStreamShape; label: string }> = [
  { value: "lorenz", label: "Lorenz Attractor" },
  { value: "spiralGalaxy", label: "Spiral Galaxy" },
  { value: "fibonacciSphere", label: "Fibonacci Sphere" },
  { value: "lissajous3d", label: "Lissajous 3D" },
];

export const DEMO_ON_OFF_OPTIONS: ReadonlyArray<{ value: "on" | "off"; label: string }> = [
  { value: "on", label: "On" },
  { value: "off", label: "Off" },
];

export const DEMO_RUNTIME_MODE_OPTIONS: ReadonlyArray<{ value: RuntimeMode; label: string }> = [
  { value: "eco", label: "Eco" },
  { value: "balanced", label: "Balanced" },
  { value: "max_throughput", label: "Max throughput" },
  { value: "custom", label: "Custom" },
];

export const DEMO_MANUAL_LOD_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 0, label: "Level 0" },
  { value: 1, label: "Level 1" },
  { value: 2, label: "Level 2" },
];

export const DEMO_IMPORTANCE_FIELD_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "", label: "None" },
  { value: "velocity", label: "Velocity" },
  { value: "intensity", label: "Intensity" },
  { value: "temperature", label: "Temperature" },
  { value: "pressure", label: "Pressure" },
];

export const DEMO_COMPARE_IMPORTANCE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "", label: "None" },
  { value: "velocity", label: "Velocity" },
  { value: "intensity", label: "Intensity" },
];

export const ATTRIBUTE_KEY_LABELS: Readonly<Record<string, string>> = {
  "": "None",
  velocity: "Velocity",
  intensity: "Intensity",
  temperature: "Temperature",
  pressure: "Pressure",
  classification: "Classification",
  rgb: "RGB",
  red: "Red",
  green: "Green",
  blue: "Blue",
  z: "Elevation (Z)",
};

export const DEMO_MODE_LABELS: Readonly<Record<"stream" | "file" | "compare", string>> = {
  stream: "Live stream",
  file: "File explorer",
  compare: "A/B compare",
};

export const RESOLVED_BACKEND_LABELS: Readonly<Record<"webgl" | "webgpu", string>> = {
  webgl: "WebGL",
  webgpu: "WebGPU",
};

export const REQUESTED_BACKEND_LABELS: Readonly<Record<RendererBackend, string>> = {
  auto: "Auto",
  webgl: "WebGL",
  webgpu: "WebGPU",
};

export const STREAM_SHAPE_REPORT_LABELS: Readonly<Record<MockStreamShape, string>> = {
  lorenz: "Lorenz Attractor",
  spiralGalaxy: "Spiral Galaxy",
  fibonacciSphere: "Fibonacci Sphere",
  lissajous3d: "Lissajous 3D",
};

export const INGEST_MODE_REPORT_LABELS: Readonly<Record<"worker" | "main", string>> = {
  worker: "Worker",
  main: "Main thread",
};

export const FILE_LOAD_STATUS_LABELS: Readonly<Record<"idle" | "loading" | "ready" | "error", string>> = {
  idle: "Idle",
  loading: "Loading",
  ready: "Ready",
  error: "Error",
};

