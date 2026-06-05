import type { SVGProps } from "react";

interface Props extends Omit<SVGProps<SVGSVGElement>, "ref"> {
  size?: number;
}

/** Chat brand mark — two interlocked pixel-art rings on an 18×18
 *  grid. The chain-link illusion is built from negative space: at
 *  every crossing only one path is drawn, the other passes
 *  'behind' as a 2-cell gap. Mirrored in `public/logo.svg` so the
 *  favicon stays in sync without a build step.
 *
 *  Pixel-trace verified against the source raster — same 8-rect
 *  decomposition, same two brand colours (#26A938 / #1E54A4), no
 *  darker-shade accents. */
export function BrandLogo({ size = 32, ...rest }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 18 18"
      xmlns="http://www.w3.org/2000/svg"
      shapeRendering="crispEdges"
      role="img"
      aria-hidden={rest["aria-label"] ? undefined : true}
      {...rest}
    >
      {/* Green ring (top-left) */}
      <rect x="0" y="0" width="12" height="3" fill="#26A938" />
      <rect x="0" y="0" width="3" height="12" fill="#26A938" />
      <rect x="0" y="10" width="6" height="2" fill="#26A938" />
      <rect x="8" y="10" width="4" height="2" fill="#26A938" />
      {/* Blue ring (bottom-right) */}
      <rect x="15" y="6" width="3" height="12" fill="#1E54A4" />
      <rect x="6" y="15" width="12" height="3" fill="#1E54A4" />
      <rect x="6" y="6" width="2" height="4" fill="#1E54A4" />
      <rect x="6" y="12" width="2" height="3" fill="#1E54A4" />
    </svg>
  );
}
