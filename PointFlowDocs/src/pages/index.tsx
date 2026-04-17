import React from "react";
import clsx from "clsx";
import Link from "@docusaurus/Link";
import useDocusaurusContext from "@docusaurus/useDocusaurusContext";
import Layout from "@theme/Layout";
import CodeBlock from "@theme/CodeBlock";
import styles from "./index.module.css";

const features = [
  {
    title: "Bounded memory",
    description:
      "Ring buffer with configurable capacity. Memory stays flat no matter how fast your stream is or how long it runs.",
  },
  {
    title: "Off-thread ingest",
    description:
      "Chunk processing runs in a dedicated Web Worker. Your main thread and render loop never pay ingest cost.",
  },
  {
    title: "WebGPU compute culling",
    description:
      "A WGSL compute shader handles frustum culling and importance sampling on the GPU. Automatic WebGL fallback on every other browser.",
  },
  {
    title: "Importance engine",
    description:
      "One score drives both buffer eviction and per-frame sampling. High-value points survive longer and render more often.",
  },
  {
    title: "Static file loading",
    description:
      "PLY, XYZ, LAS, LAZ, and COPC files parse off-thread with progressive rendering. Points appear as they load.",
  },
  {
    title: "React-native API",
    description:
      "Drop-in components and hooks with full TypeScript types. Render live points in under 10 lines of code.",
  },
];

export default function Home() {
  const { siteConfig } = useDocusaurusContext();
  return (
    <Layout
      description="Bounded ring buffer, WebGPU compute culling, off-thread ingest, and a unified importance engine for live point-cloud streams in React."
    >
      <header className={styles.hero}>
        <div className={styles.heroInner}>
          <img src="img/logo.png" alt="PointFlow logo" className={styles.heroLogo} />
          <h1 className={styles.heroTitle}>{siteConfig.title}</h1>
          <p className={styles.heroTagline}>{siteConfig.tagline}</p>
          <div className={styles.heroStats}>
            <span className={styles.statChip}>WebGPU + automatic WebGL fallback</span>
            <span className={styles.statChip}>Bounded memory by design</span>
            <span className={styles.statChip}>393 tests passing in CI</span>
          </div>
          <div className={styles.heroCta}>
            <Link className={clsx(styles.btn, styles.btnPrimary)} to="/docs/getting-started/quick-start">
              Get started
            </Link>
            <Link className={clsx(styles.btn, styles.btnOutline)} href="https://pointflow-demo.vercel.app">
              Live demo
            </Link>
          </div>
          <div className={styles.installLine}>
            <code>npm install pointflow</code>
          </div>
        </div>
      </header>

      <main>
        <section className={styles.features}>
          <div className={styles.container}>
            <div className={styles.featureGrid}>
              {features.map((f) => (
                <div key={f.title} className={styles.featureCard}>
                  <h3 className={styles.featureTitle}>{f.title}</h3>
                  <p className={styles.featureDesc}>{f.description}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className={styles.codeSection}>
          <div className={styles.container}>
            <div className={styles.codeSectionInner}>
              <div className={styles.codeSectionText}>
                <h2 className={styles.codeSectionTitle}>Up in minutes</h2>
                <p className={styles.codeSectionSub}>
                  Mount the component, connect your stream, push chunks. The
                  buffer, worker, and renderer are all managed for you.
                </p>
                <Link
                  className={clsx(styles.btn, styles.btnPrimary)}
                  to="/docs/getting-started/quick-start"
                >
                  Read the quick start
                </Link>
              </div>
              <CodeBlock className={styles.codeBlock} language="tsx">{`import { StreamedPointCloud } from "pointflow";
import { createWebSocketAdapter } from "pointflow";

function Scene() {
  const adapter = createWebSocketAdapter(
    "wss://your-lidar-stream"
  );

  return (
    <StreamedPointCloud
      adapter={adapter}
      maxPoints={50_000}
    />
  );
}`}</CodeBlock>
            </div>
          </div>
        </section>
      </main>
    </Layout>
  );
}
