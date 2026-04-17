import { fireEvent, render } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { PointCloudDropzone } from "../src/components/PointCloudDropzone";

describe("PointCloudDropzone", () => {
  test("emits dropped file", () => {
    const onSourceChange = vi.fn();
    const { getByRole } = render(<PointCloudDropzone onSourceChange={onSourceChange} />);
    const zone = getByRole("button");
    const file = new File(["x y z"], "scan.xyz", { type: "text/plain" });
    fireEvent.drop(zone, { dataTransfer: { files: [file] } });
    expect(onSourceChange).toHaveBeenCalledWith(file);
  });
});
