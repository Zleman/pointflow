import type { SidebarsConfig } from "@docusaurus/plugin-content-docs";

const sidebars: SidebarsConfig = {
  docs: [
    {
      type: "doc",
      id: "intro",
      label: "Introduction",
    },
    {
      type: "category",
      label: "Getting started",
      collapsed: false,
      items: [
        "getting-started/installation",
        "getting-started/quick-start",
      ],
    },
    {
      type: "category",
      label: "Guides",
      items: [
        "guides/streaming",
        "guides/static-files",
        "guides/copc",
        "guides/importance-engine",
        "guides/point-picking",
        "guides/quantized-transport",
        "guides/temporal-window",
        "guides/config-module",
        "guides/dynamic-allocation",
        "guides/performance",
        "guides/ros-integration",
      ],
    },
    {
      type: "category",
      label: "API reference",
      items: [
        "api/streamed-point-cloud",
        "api/point-cloud",
        "api/point-cloud-dropzone",
        "api/copc-point-cloud",
        "api/use-point-flow",
        "api/transports",
        "api/config",
        "api/errors",
        "api/types",
      ],
    },
    {
      type: "category",
      label: "Architecture",
      items: [
        "architecture/overview",
        "architecture/ring-buffer",
        "architecture/importance-engine",
        "architecture/webgpu-pipeline",
      ],
    },
    {
      type: "doc",
      id: "changelog",
      label: "Changelog",
    },
  ],
};

export default sidebars;
