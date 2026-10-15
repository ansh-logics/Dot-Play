import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./TrayPlayer.css";
import { TrayPlayer } from "./TrayPlayer";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TrayPlayer />
  </StrictMode>,
);
