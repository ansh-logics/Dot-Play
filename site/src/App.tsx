import { useRepoInfo } from "./lib/github";
import { Film } from "./sections/Film";
import { Hero } from "./sections/Hero";
import { Nav } from "./sections/Nav";
import { BuiltLight, Faq, FinalCta, Footer, Install } from "./sections/Rest";
import { Showcase } from "./sections/Showcase";

export function App() {
  const info = useRepoInfo();
  return (
    <>
      <Nav info={info} />
      <main>
        <Hero info={info} />
        <Showcase />
        <Film />
        <BuiltLight />
        <Install info={info} />
        <Faq />
        <FinalCta info={info} />
      </main>
      <Footer />
    </>
  );
}
