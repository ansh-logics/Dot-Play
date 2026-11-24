import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/doto/800.css";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/700.css";
import { HeroDemo } from "./HeroDemo";
import { FeatureBento, ImportTile, KeysTile, MenuBarTile, RemoteTile } from "./Bento";

/** Dev-only page that shows one demo alone, for filming with stageshow's film.mjs. */
const demos: Record<string, () => React.ReactNode> = {
  hero: () => <HeroDemo />,
  bento: () => <FeatureBento />,
  remote: () => <RemoteTile />,
  menu: () => <MenuBarTile />,
  import: () => <ImportTile />,
  keys: () => <KeysTile />,
};
const name = new URLSearchParams(location.search).get("demo") ?? "hero";
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <div id="example" style={{ maxWidth: Number(new URLSearchParams(location.search).get("w") ?? 1080), margin: "0 auto" }}>
      {demos[name]?.()}
    </div>
  </StrictMode>,
);
