---
id: point-cloud-dropzone
title: PointCloudDropzone
sidebar_position: 3
---

# PointCloudDropzone

A minimal drag-and-drop file picker that resolves a dropped or selected file into a `PointCloudSource` and passes it to your handler. Use it as a wrapper around `<PointCloud>` to let users load their own files.

```tsx
import { PointCloudDropzone } from "pointflow";
```

## Example

```tsx
import { useState } from "react";
import { PointCloud, PointCloudDropzone } from "pointflow";
import type { PointCloudSource } from "pointflow";

function FileViewer() {
  const [src, setSrc] = useState<PointCloudSource | null>(null);

  return (
    <div>
      <PointCloudDropzone onSourceChange={setSrc}>
        Drop a point cloud file here, or click to browse.
      </PointCloudDropzone>
      {src && <PointCloud src={src} />}
    </div>
  );
}
```

## Props

| Prop | Type | Default | Description |
|---|---|---|---|
| `onSourceChange` | `(source: PointCloudSource) => void` | Required | Called with the selected `File` when the user drops or picks one. |
| `disabled` | `boolean` | `false` | Prevents interaction and dims the zone. |
| `accept` | `string` | `".las,.laz,.copc.laz,.ply,.xyz,.csv,.txt"` | `accept` attribute passed to the hidden file input. |
| `className` | `string` | `undefined` | CSS class applied to the outer div. |
| `style` | `React.CSSProperties` | `undefined` | Inline styles applied to the outer div. |
| `children` | `ReactNode` | `"Drop a point cloud file or click to open."` | Content rendered inside the drop zone. |

## Notes

- The component renders a styled `<div>` with a dashed border. The border colour shifts on drag-over. Pass `className` or `style` to override the default appearance entirely.
- The `accept` prop filters the file picker dialog but does not validate dropped files. Invalid files will be passed to `onSourceChange` and fail later during parsing inside `<PointCloud>`.
- Keyboard accessible: `Enter` and `Space` open the file picker when the zone is focused.
- The `PointCloudSource` type accepted by `<PointCloud src={...}>` includes `File`, so you can pass the value from `onSourceChange` directly.
