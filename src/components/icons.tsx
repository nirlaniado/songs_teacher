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
  folder: <path d="M2.5 12V4.5a1 1 0 0 1 1-1h3l1.5 1.5h4.5a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z" />,
  guitar: <path d="M9.5 6.5 13 3l1 1-3.5 3.5M6.5 6.5a2 2 0 0 1 2.2.3l.5.5a2 2 0 0 1 .3 2.2c-.3.6-1 .8-1.4 1.3-.5.7-.3 1.6-1 2.3a2.6 2.6 0 0 1-3.7 0l-1.2-1.2a2.6 2.6 0 0 1 0-3.7c.7-.7 1.6-.5 2.3-1 .5-.4.7-1.1 1.2-1.4zM5.5 9.5l1 1" />,
  study: <path d="M8 3 1.5 6 8 9l6.5-3zM4 7.5V11c0 1 1.8 2 4 2s4-1 4-2V7.5M14.5 6v3.5" />,
  library: <path d="M2.5 6.5v3M5.25 4v8M8 2.5v11M10.75 4.5v7M13.5 6.5v3" />,
  search: <path d="M7 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM14 14l-3.4-3.4" />,
  list: <path d="M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01" />,
  gridView: <path d="M2.5 2.5h4.5V7H2.5zM9 2.5h4.5V7H9zM2.5 9h4.5v4.5H2.5zM9 9h4.5v4.5H9z" />,
  more: <path d="M3.5 8h.01M8 8h.01M12.5 8h.01" strokeWidth="2.2" />,
  trash: <path d="M2.5 4.5h11M6 4.5V3a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 .5.5v1.5M4 4.5l.6 8.1a1 1 0 0 0 1 .9h4.8a1 1 0 0 0 1-.9l.6-8.1M6.75 7.5v3.5M9.25 7.5v3.5" />,
  file: <path d="M9 2H4.5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V5.5zM9 2v3.5h3.5M5.75 8.5h4.5M5.75 11h4.5" />,
  upload: <path d="M8 10.5v-8M4.5 6 8 2.5 11.5 6M3 13.5h10" />,
  layers: <path d="M8 2 1.5 5.5 8 9l6.5-3.5zM1.5 8.5 8 12l6.5-3.5M1.5 11 8 14.5l6.5-3.5" />,
  exit: <path d="M6 13.5H3.5a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1H6M10.5 11l3-3-3-3M13.5 8h-7.5" />,
  play: <path fill="currentColor" d="M5 3v10l8-5z" />,
  pause: <path fill="currentColor" d="M4.5 3h2.5v10H4.5zM9 3h2.5v10H9z" />,
} as const;

export type IconName = keyof typeof SHAPES;

/** Drawn rather than typed: Unicode glyphs fall back per platform, so the same toolbar came out at mixed sizes and weights. */
export function Icon({ name, size = 14 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
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
