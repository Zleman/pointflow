/**
 * SharedArrayBuffer availability detection.
 *
 * SharedArrayBuffer (SAB) enables zero-copy sharing between the ingest worker
 * and the main thread. When available, data written by the worker is immediately
 * visible to the main thread with no serialisation cost.
 *
 * SAB requires Cross-Origin Isolation, enabled by serving with these HTTP headers:
 *   Cross-Origin-Opener-Policy:  same-origin
 *   Cross-Origin-Embedder-Policy: require-corp
 *
 * Without these headers, `crossOriginIsolated` is false and SAB is unavailable.
 * PointFlow's internal worker bridge automatically uses Transferable ArrayBuffers
 * as a fallback (the current default behaviour).
 *
 * This utility lets host applications check SAB availability at runtime and
 * display appropriate guidance when headers are not set.
 */

export interface SabStatus {
  /** Whether SharedArrayBuffer is available in this browsing context. */
  available: boolean;
  /**
   * Whether the page is cross-origin isolated.
   * If false, the required COOP/COEP headers are not set.
   */
  crossOriginIsolated: boolean;
  /**
   * Human-readable explanation, including required headers when not available.
   */
  message: string;
}

/**
 * Detect SharedArrayBuffer availability and cross-origin isolation status.
 *
 * @example
 * ```ts
 * const status = detectSabSupport();
 * if (!status.available) {
 *   console.warn(status.message);
 * }
 * ```
 */
export function detectSabSupport(): SabStatus {
  const isolated = typeof crossOriginIsolated !== "undefined" && crossOriginIsolated;
  const available = isolated && typeof SharedArrayBuffer !== "undefined";

  const message = available
    ? "SharedArrayBuffer available — zero-copy ingest worker active."
    : isolated
      ? "Cross-origin isolated but SharedArrayBuffer not available in this environment."
      : [
          "SharedArrayBuffer unavailable — cross-origin isolation not active.",
          "To enable zero-copy ingest, serve with these HTTP headers:",
          "  Cross-Origin-Opener-Policy: same-origin",
          "  Cross-Origin-Embedder-Policy: require-corp",
          "PointFlow falls back to Transferable ArrayBuffers automatically.",
        ].join(" ");

  return { available, crossOriginIsolated: isolated, message };
}
