import { createRoot } from "react-dom/client";
import { StrictMode } from "react";
import { NoteApp } from "./NoteApp.tsx";
import "../hub/styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <NoteApp />
  </StrictMode>,
);
