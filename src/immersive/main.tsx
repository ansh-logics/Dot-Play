import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../components/vinyl/vinyl.css";
import "./Immersive.css";
import { Immersive } from "./Immersive";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Immersive />
  </StrictMode>,
);
