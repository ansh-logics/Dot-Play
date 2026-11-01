import { useEffect, useRef, useState } from "react";
import { sharperCoverUrl } from "./hooks";

/** YouTube answers a missing video frame with a 120×90 grey placeholder, not an error. */
const MIN_REAL_WIDTH = 200;

/**
 * A cover at the quality the display can show. The normal cover appears at once; a sharper
 * copy sized for this cover's pixels loads behind it and fades in once it's decoded, so the
 * picture only ever gets sharper. A broken image is never shown, and `zoom` crops away the
 * black bars baked into video frames.
 */
export function Cover({ url, zoom = 1 }: { url: string | null; zoom?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [baseFailed, setBaseFailed] = useState<string | null>(null);
  const [sharp, setSharp] = useState<{ for: string; url: string } | null>(null);

  useEffect(() => {
    if (!url) return;
    const box = ref.current?.getBoundingClientRect();
    const px = Math.max(box?.width ?? 0, box?.height ?? 0) * (window.devicePixelRatio || 1);
    const candidate = sharperCoverUrl(url, px || 1600);
    if (!candidate) return;
    let cancelled = false;
    const img = new Image();
    img.referrerPolicy = "no-referrer";
    img.src = candidate;
    img
      .decode()
      .then(() => {
        if (!cancelled && img.naturalWidth >= MIN_REAL_WIDTH) setSharp({ for: url, url: candidate });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [url]);

  const style = zoom > 1 ? { transform: `scale(${zoom})` } : undefined;
  const sharpUrl = sharp?.for === url ? sharp.url : null;

  return (
    <div className="im-cover" ref={ref}>
      {url && baseFailed !== url && (
        <img src={url} alt="" referrerPolicy="no-referrer" draggable={false} style={style} onError={() => setBaseFailed(url)} />
      )}
      {sharpUrl && (
        <img key={sharpUrl} className="im-cover-sharp" src={sharpUrl} alt="" referrerPolicy="no-referrer" draggable={false} style={style} />
      )}
    </div>
  );
}
