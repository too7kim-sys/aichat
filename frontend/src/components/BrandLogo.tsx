import type { SVGProps } from "react";

interface Props extends Omit<SVGProps<SVGSVGElement>, "ref"> {
  size?: number;
}

/** Chat brand mark — two interlocked pixel-art L-frames on a 12×12
 *  grid, 2-unit thick bars (~16% of the canvas). Background is
 *  transparent so the mark drops cleanly onto any surface. Mirrored
 *  in `public/logo.svg` for the favicon. */
export function BrandLogo({ size = 32, ...rest }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 12 12"
      xmlns="http://www.w3.org/2000/svg"
      shapeRendering="crispEdges"
      role="img"
      aria-hidden={rest["aria-label"] ? undefined : true}
      {...rest}
    >
      {/* Green L-frame, top-left. */}
      <rect x="0" y="0" width="8" height="2" fill="#22A93A" />
      <rect x="0" y="0" width="2" height="8" fill="#22A93A" />
      {/* Blue L-frame, bottom-right. */}
      <rect x="4" y="10" width="8" height="2" fill="#1E58B4" />
      <rect x="10" y="4" width="2" height="8" fill="#1E58B4" />
      {/* Darker-green hooks at the crossing — sell the interlock
          without trying to physically thread the paths. */}
      <rect x="6" y="4" width="2" height="2" fill="#1B7A2C" />
      <rect x="4" y="6" width="2" height="2" fill="#1B7A2C" />
    </svg>
  );
}
