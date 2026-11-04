import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MotionConfig } from "motion/react";
import "./remote.css";
import { RemoteApp } from "./RemoteApp";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MotionConfig reducedMotion="user">
      <RemoteApp />
    </MotionConfig>
  </StrictMode>,
);
