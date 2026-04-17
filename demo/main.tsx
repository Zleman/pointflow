import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

if (import.meta.env.DEV) {
  const reactDevtoolsHint = "Download the React DevTools";
  const origInfo = console.info.bind(console);
  console.info = (...args: unknown[]) => {
    if (typeof args[0] === "string" && args[0].includes(reactDevtoolsHint)) return;
    origInfo(...args);
  };
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
