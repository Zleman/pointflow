export type PointFlowErrorCode =
  | "PF_ABORTED"
  | "PF_PARSE_FAILED"
  | "PF_UNSUPPORTED_FORMAT"
  | "PF_INVALID_SOURCE"
  | "PF_WORKER_INIT_FAILED"
  | "PF_NETWORK_RANGE_UNAVAILABLE"
  | "PF_UNKNOWN";

export class PointFlowError extends Error {
  readonly code: PointFlowErrorCode;
  readonly causeValue?: unknown;

  constructor(code: PointFlowErrorCode, message: string, causeValue?: unknown) {
    super(message);
    this.name = "PointFlowError";
    this.code = code;
    this.causeValue = causeValue;
  }
}

export function toPointFlowError(
  code: PointFlowErrorCode,
  message: string,
  causeValue?: unknown,
): PointFlowError {
  if (causeValue instanceof PointFlowError) return causeValue;
  return new PointFlowError(code, message, causeValue);
}
