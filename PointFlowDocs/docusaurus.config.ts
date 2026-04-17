import { themes as prismThemes } from "prism-react-renderer";
import type { Config } from "@docusaurus/types";
import type * as Preset from "@docusaurus/preset-classic";

const config: Config = {
  future: {
    faster: {
      swcJsLoader: true,
      swcJsMinimizer: true,
      swcHtmlMinimizer: true,
      lightningCssMinimizer: true,
      rspackBundler: true,
      mdxCrossCompilerCache: true,
    },
  },
  title: "PointFlow",
  tagline: "React-first engine for live point-cloud streams",
  favicon: "img/favicon.png",

  url: "https://pointflow-docs.vercel.app",
  baseUrl: "/",

  organizationName: "Zleman",
  projectName: "pointflow",

  onBrokenLinks: "throw",
  markdown: {
    hooks: {
      onBrokenMarkdownLinks: "warn",
    },
  },

  i18n: {
    defaultLocale: "en",
    locales: ["en"],
  },

  plugins: [
    [
      "@easyops-cn/docusaurus-search-local",
      {
        hashed: true,
        indexDocs: true,
        indexPages: true,
        docsRouteBasePath: "/docs",
      },
    ],
  ],

  presets: [
    [
      "classic",
      {
        docs: {
          sidebarPath: "./sidebars.ts",
          editUrl: "https://github.com/Zleman/pointflow/tree/main/PointFlowDocs/",
          versions: {
            current: {
              label: "v0.1.0",
              badge: true,
            },
          },
        },
        blog: false,
        theme: {
          customCss: "./src/css/custom.css",
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    image: "img/og-card.png",
    colorMode: {
      defaultMode: "dark",
      disableSwitch: false,
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: "PointFlow",
      logo: {
        alt: "PointFlow logo",
        src: "img/logo.png",
      },
      items: [
        {
          type: "docSidebar",
          sidebarId: "docs",
          position: "left",
          label: "Docs",
        },
        {
          type: "docsVersionDropdown",
          position: "right",
        },
        {
          href: "https://pointflow-demo.vercel.app",
          label: "Live demo",
          position: "right",
        },
        {
          href: "https://github.com/Zleman/pointflow",
          label: "GitHub",
          position: "right",
        },
      ],
    },
    footer: {
      style: "dark",
      links: [
        {
          title: "Learn",
          items: [
            { label: "Introduction", to: "/docs/intro" },
            { label: "Quick start", to: "/docs/getting-started/quick-start" },
            { label: "Guides", to: "/docs/guides/streaming" },
          ],
        },
        {
          title: "Reference",
          items: [
            { label: "StreamedPointCloud", to: "/docs/api/streamed-point-cloud" },
            { label: "PointCloud", to: "/docs/api/point-cloud" },
            { label: "CopcPointCloud", to: "/docs/api/copc-point-cloud" },
            { label: "usePointFlow", to: "/docs/api/use-point-flow" },
          ],
        },
        {
          title: "More",
          items: [
            { label: "Live demo", href: "https://pointflow-demo.vercel.app" },
            { label: "npm", href: "https://www.npmjs.com/package/pointflow" },
            { label: "GitHub", href: "https://github.com/Zleman/pointflow" },
            { label: "Changelog", to: "/docs/changelog" },
          ],
        },
      ],
      copyright: `Built by Mudar Tayy <a href="mailto:mudartayy@gmail.com">mudartayy@gmail.com</a>`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ["bash", "typescript", "tsx", "json"],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
