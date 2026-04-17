import { toPointFlowError } from "../core/errors";

export type PointCloudSource = string | URL | Request | File | Blob;

export interface ResolvedPointCloudSource {
  url: string;
  sourceKind: "url" | "request" | "file" | "blob";
  revoke: () => void;
}

function fileHintFromName(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".copc.laz") || lower.includes(".copc.")) return "#.copc.laz";
  const ext = lower.split(".").pop() ?? "";
  if (ext === "las" || ext === "laz") {
    return `#.${ext}`;
  }
  return "";
}

export function resolvePointCloudSource(source: PointCloudSource): ResolvedPointCloudSource {
  if (typeof source === "string") {
    return { url: source, sourceKind: "url", revoke: () => {} };
  }
  if (typeof URL === "function" && source instanceof URL) {
    return { url: source.toString(), sourceKind: "url", revoke: () => {} };
  }
  if (typeof Request === "function" && source instanceof Request) {
    return { url: source.url, sourceKind: "request", revoke: () => {} };
  }
  if (!(source instanceof Blob)) {
    throw toPointFlowError("PF_INVALID_SOURCE", "Unsupported point cloud source type.");
  }
  if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
    throw toPointFlowError("PF_INVALID_SOURCE", "Blob/File sources require URL.createObjectURL support.");
  }
  const objectUrl = URL.createObjectURL(source);
  if (source instanceof File) {
    return {
      url: objectUrl + fileHintFromName(source.name),
      sourceKind: "file",
      revoke: () => URL.revokeObjectURL(objectUrl),
    };
  }
  return {
    url: objectUrl,
    sourceKind: "blob",
    revoke: () => URL.revokeObjectURL(objectUrl),
  };
}
