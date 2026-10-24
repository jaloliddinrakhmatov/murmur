import { createRoot } from "react-dom/client";
import { StrictMode } from "react";
import { Panel } from "./Panel.tsx";
import "../hub/styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Panel />
  </StrictMode>,
);
