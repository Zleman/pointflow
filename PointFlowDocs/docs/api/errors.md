---
id: errors
title: Error codes
sidebar_position: 7
---

# Error codes

PointFlow uses a typed error class with stable codes. Catch it anywhere you handle load or ingest failures.

```ts
import { PointFlowError } from "pointflow";
```

## PointFlowError

```ts
class PointFlowError extends Error {
  readonly code: PointFlowErrorCode;
}
```

## Error codes

| Code | When it occurs |
|---|---|
| `PF_ABORTED` | A load was cancelled via `abort()`. |
| `PF_PARSE_FAILED` | The file couldn't be parsed. Malformed header, corrupt data, or unsupported variant. |
| `PF_UNSUPPORTED_FORMAT` | The file extension or magic bytes aren't recognized. |
| `PF_INVALID_SOURCE` | `src` is null, undefined, or an unresolvable value. |
| `PF_WORKER_INIT_FAILED` | The ingest or loader Web Worker failed to start. Usually a CSP or environment issue. |
| `PF_NETWORK_RANGE_UNAVAILABLE` | An HTTP range request was denied by the server. Needed for COPC tile fetching. |

## Handling errors

```tsx
<PointCloud
  src={src}
  onError={(err) => {
    if (err.code === "PF_ABORTED") {
      // user cancelled, not an error to report
      return;
    }
    if (err.code === "PF_UNSUPPORTED_FORMAT") {
      showToast("That file format isn't supported. Try PLY, XYZ, LAS, or LAZ.");
      return;
    }
    // unexpected error
    reportError(err);
  }}
/>
```

## Checking for PointFlowError

```ts
import { PointFlowError } from "pointflow";

function isPointFlowError(err: unknown): err is PointFlowError {
  return err instanceof PointFlowError;
}
```

## Worker errors

`PF_WORKER_INIT_FAILED` is the most common error in restricted environments. It fires when the browser blocks Worker creation, which happens under strict Content Security Policy settings. Adding `worker-src 'self' blob:` to your CSP usually fixes it.
