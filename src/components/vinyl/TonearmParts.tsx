/*
 * Tonearm drawn in a 100×100 box over the record (centre 50,50, radius 46; label radius 19).
 * Pivot at (82,16): rotate the <svg> about 82% 16% to move the needle.
 */
export function TonearmParts() {
  return (
    <>
      {/* soft shadow: the arm path offset, no filter */}
      <path d="M84 18 L71 65 L68 72" className="vinyl-arm-shadow" />
      <line x1="82" y1="16" x2="89" y2="5" className="vinyl-arm-weight" />
      <circle cx="82" cy="16" r="6.5" className="vinyl-arm-base" />
      <path d="M82 16 L69 63 L66 70" className="vinyl-arm-tube" />
      <path d="M63.2 67.6 L69.4 69.9 L67.4 76.2 L61.2 73.9 Z" className="vinyl-arm-head" />
      <circle cx="82" cy="16" r="2.6" className="vinyl-arm-cap" />
    </>
  );
}
