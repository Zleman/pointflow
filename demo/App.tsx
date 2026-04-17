import React, { Component, useEffect, useState, type ErrorInfo, type ReactNode } from "react";
import { DemoProvider, useDemoCanvas } from "./DemoContext";
import { BenchmarkProvider } from "./contexts/BenchmarkContext";
import { CanvasConfigProvider, useCanvasConfig, useCanvasConfigDispatch } from "./contexts/CanvasConfigContext";
import { CompareProvider } from "./contexts/CompareContext";
import { FileProvider } from "./contexts/FileContext";
import { HudProvider } from "./contexts/HudContext";
import { SuiteProvider } from "./contexts/SuiteContext";
import {
  CompareControlsStep,
  FileControlsStep,
  ModeStep,
  StreamControlsStep,
} from "./app/WizardSteps";
import { CompareScene, FileScene, MetricsRail, StreamScene } from "./app/ScenePanels";

type StageErrorBoundaryProps = { children: ReactNode; modeKey: string };
type StageErrorBoundaryState = { error: Error | null };

class StageErrorBoundary extends Component<StageErrorBoundaryProps, StageErrorBoundaryState> {
  override state: StageErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): StageErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Stage error:", error, info);
  }

  override componentDidUpdate(prevProps: StageErrorBoundaryProps) {
    if (prevProps.modeKey !== this.props.modeKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  override render() {
    if (this.state.error) {
      return (
        <div className="stage-error-fallback" role="alert">
          <p className="stage-error-title">The viewer hit an error.</p>
          <pre className="stage-error-message">{this.state.error.message}</pre>
          <button
            type="button"
            className="stage-error-reset btn-primary"
            onClick={() => this.setState({ error: null })}
          >
            Reset viewer
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

const THEMES = [
  { value: "dark",  label: "Dark" },
  { value: "light", label: "Light" },
] as const;
type ThemeId = (typeof THEMES)[number]["value"];

const THEME_DEFAULT_BG: Record<ThemeId, string> = {
  dark:  "#0d1117",
  light: "#ffffff",
};

function AppContent({ theme, setTheme }: { theme: ThemeId; setTheme: (t: ThemeId) => void }) {
  const { demoMode } = useCanvasConfig();
  const canvas = useDemoCanvas();
  const dispatch = useCanvasConfigDispatch();

  useEffect(() => {
    dispatch({ type: "SET_CANVAS_BG", value: THEME_DEFAULT_BG[theme] });
  }, [theme, dispatch]);

  return (
    <div className="demo-shell">
      <header className="topbar">
        <div className="topbar-brand">
          <img src="/pointflow_logo_transparent.png" alt="PointFlow logo" className="topbar-logo" />
          <h1 className="topbar-title">PointFlow</h1>
        </div>
        <div className="topbar-right">
          <nav className="topbar-links" aria-label="PointFlow links">
            <a href={__POINTFLOW_PKG_HOMEPAGE__} target="_blank" rel="noreferrer">Docs</a>
            <span className="topbar-links-sep" aria-hidden>·</span>
            <a href={__POINTFLOW_PKG_REPO__} target="_blank" rel="noreferrer">Repository</a>
            <span className="topbar-links-sep" aria-hidden>·</span>
            <span className="topbar-version">v{__POINTFLOW_PKG_VERSION__}</span>
          </nav>
          <select
            className="theme-select"
            value={theme}
            onChange={(e) => setTheme(e.target.value as ThemeId)}
            aria-label="UI theme"
          >
            {THEMES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
          <div className="status-pill" aria-live="polite">
            {canvas.streaming || canvas.compareStreaming ? "Running" : "Idle"}
          </div>
        </div>
      </header>

      <div className="layout">
        <aside className="wizard" aria-label="Demo wizard">
          <ModeStep />
          {demoMode === "stream" && <StreamControlsStep />}
          {demoMode === "file" && <FileControlsStep />}
          {demoMode === "compare" && <CompareControlsStep />}
        </aside>

        <main className="stage" aria-label="Point cloud viewport">
          <StageErrorBoundary modeKey={demoMode}>
            {demoMode === "stream" && <StreamScene />}
            {demoMode === "file" && <FileScene />}
            {demoMode === "compare" && <CompareScene />}
          </StageErrorBoundary>
        </main>

        <MetricsRail />
      </div>
    </div>
  );
}

export default function App() {
  const [theme, setTheme] = useState<ThemeId>(
    () => {
      const stored = localStorage.getItem("pf-theme");
      const migrate: Record<string, ThemeId> = {
        volt: "dark", ocean: "dark", midnight: "dark", violet: "dark", earth: "dark",
        stone: "dark", pearl: "light",
      };
      if (stored && migrate[stored]) return migrate[stored];
      const valid: ThemeId[] = ["dark", "light"];
      const systemDefault: ThemeId = window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
      return (valid.includes(stored as ThemeId) ? stored as ThemeId : null) ?? systemDefault;
    }
  );

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("pf-theme", theme);
  }, [theme]);

  return (
    <CanvasConfigProvider>
      <FileProvider>
        <BenchmarkProvider>
          <SuiteProvider>
            <CompareProvider>
              <HudProvider>
                <DemoProvider>
                  <AppContent theme={theme} setTheme={setTheme} />
                </DemoProvider>
              </HudProvider>
            </CompareProvider>
          </SuiteProvider>
        </BenchmarkProvider>
      </FileProvider>
    </CanvasConfigProvider>
  );
}
