const SHAPES = {
  toFront: <path d="M3 2.5h10M8 14V5.5M4.5 9 8 5.5 11.5 9" />,
  forward: <path d="M8 13V3.5M4 7.5l4-4 4 4" />,
  backward: <path d="M8 3v9.5M4 8.5l4 4 4-4" />,
  toBack: <path d="M3 13.5h10M8 2v8.5M4.5 7 8 10.5 11.5 7" />,
  alignLeft: <path d="M2.5 2v12M5 3.5h8v3H5zM5 9.5h5v3H5z" />,
  alignCentre: <path d="M8 2v12M4 3.5h8v3H4zM5.5 9.5h5v3h-5z" />,
  alignRight: <path d="M13.5 2v12M3 3.5h8v3H3zM6 9.5h5v3H6z" />,
  alignTop: <path d="M2 2.5h12M3.5 5h3v8h-3zM9.5 5h3v5h-3z" />,
  alignMiddle: <path d="M2 8h12M3.5 4h3v8h-3zM9.5 5.5h3v5h-3z" />,
  alignBottom: <path d="M2 13.5h12M3.5 3h3v8h-3zM9.5 6h3v5h-3z" />,
  distributeH: <path d="M2.5 2v12M13.5 2v12M6.5 4.5h3v7h-3z" />,
  distributeV: <path d="M2 2.5h12M2 13.5h12M4.5 6.5h7v3h-7z" />,
  duplicate: (
    <>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M3.5 10.5H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h6.5a1 1 0 0 1 1 1v.5" />
    </>
  ),
  grid: (
    <>
      <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
      <path d="M2.5 8h11M8 2.5v11" />
    </>
  ),
  magnet: <path d="M3 3v5a5 5 0 0 0 10 0V3h-3v5a2 2 0 0 1-4 0V3zM3 5.5h3M10 5.5h3" />,
  undo: <path d="M5 3 2.5 5.5 5 8M2.5 5.5H10a3.5 3.5 0 0 1 0 7H6" />,
  redo: <path d="m11 3 2.5 2.5L11 8M13.5 5.5H6a3.5 3.5 0 0 0 0 7h4" />,
  plus: <path d="M8 3v10M3 8h10" />,
  close: <path d="m4 4 8 8M12 4l-8 8" />,
  chevronDown: <path d="m4 6 4 4 4-4" />,
  arrowLeft: <path d="M13 8H3M7 4 3 8l4 4" />,
  arrowRight: <path d="M3 8h10M9 4l4 4-4 4" />,
  download: <path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10" />,
  music: (
    <>
      <path d="M6 12V3.5l7-1.5V10.5" />
      <circle cx="4.25" cy="12" r="1.75" />
      <circle cx="11.25" cy="10.5" r="1.75" />
    </>
  ),
  focus: <path d="M2.5 5.5V3a.5.5 0 0 1 .5-.5h2.5M10.5 2.5H13a.5.5 0 0 1 .5.5v2.5M13.5 10.5V13a.5.5 0 0 1-.5.5h-2.5M5.5 13.5H3a.5.5 0 0 1-.5-.5v-2.5" />,
  exitFocus: <path d="M5.5 2.5V5a.5.5 0 0 1-.5.5H2.5M10.5 2.5V5a.5.5 0 0 0 .5.5h2.5M13.5 10.5H11a.5.5 0 0 0-.5.5v2.5M2.5 10.5H5a.5.5 0 0 1 .5.5v2.5" />,
  play: <path fill="currentColor" d="M5 3v10l8-5z" />,
  pause: <path fill="currentColor" d="M4.5 3h2.5v10H4.5zM9 3h2.5v10H9z" />,
} as const;

export type IconName = keyof typeof SHAPES;

/** Drawn rather than typed: Unicode glyphs fall back per platform, so the same toolbar came out at mixed sizes and weights. */
export function Icon({ name }: { name: IconName }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0"
    >
      {SHAPES[name]}
    </svg>
  );
}
