import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { WINDOW } from "./lib/planner";
import { OverlayApp } from "./overlay/OverlayApp";

// The same front end serves the main window and the tray pop-up.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{WINDOW === "overlay" ? <OverlayApp /> : <App />}</React.StrictMode>,
);
