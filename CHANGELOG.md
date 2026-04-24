# Changelog

## [0.1.1] - 2026-04-24

### Added
- PCD format support: ASCII, binary, and binary-compressed (LZ4) variants. ROS-native format, auto-detected by extension.
- E57 format support: ASTM E2807 bit-pack codec, multi-scan files, intensity and colour channels. Auto-detected by extension.
- GPU point picking on WebGPU: a dedicated render pass encodes ring-buffer slot indices into an R32Uint texture; one pixel is read back asynchronously and resolved within one frame. Coordinates are DPR-scaled for correct results on HiDPI displays. The WebGL path falls back to the existing CPU `pickNearest` unchanged.
- CI quality gate: TypeScript typecheck and full test suite now run on every push in addition to the Vite build.

### Fixed
- Worker bridge stale closure in `usePointFlow`: `onRawIngest` now reads from a ref updated on every render, so a new callback takes effect without toggling `workerMode`.
- Color-by attribute pipeline: `availableAttributes` now uses `null` as the "not yet reported" sentinel instead of `[]`, preventing the color dropdown from locking to `z` before COPC attributes arrive after `onReady`.
- React 19 peer compatibility: upgraded `@react-three/drei` to v10, which declares React 19 in its peer range. `npm ls` no longer reports `ELSPROBLEMS`.

## [0.1.0] - 2026-04-18

Initial public release. See the [documentation](https://pointflow-docs.vercel.app) for the full feature set.
