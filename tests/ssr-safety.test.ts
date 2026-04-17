import { describe, expect, test } from "vitest";
import { detectWebGPUSync, resolveRenderer } from "../src/webgpu/capability";

describe("SSR safety", () => {
  test("renderer capability checks do not throw without navigator", () => {
    const originalNavigator = (globalThis as { navigator?: Navigator }).navigator;
    Reflect.deleteProperty(globalThis as object, "navigator");
    expect(detectWebGPUSync()).toBe(false);
    expect(resolveRenderer("auto")).toBe("webgl");
    if (originalNavigator !== undefined) {
      (globalThis as { navigator?: Navigator }).navigator = originalNavigator;
    }
  });
});
