// Inline stroke icons, drawn as paths so no icon font or asset request is needed
// (the renderer's CSP allows neither). They inherit `currentColor`, so a selected
// sidebar row tints its icon for free.
const paths = {
  home: ["M3 10.4 12 3l9 7.4V20a1 1 0 0 1-1 1h-5v-6.5H9V21H4a1 1 0 0 1-1-1z"],
  target: ["M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0", "M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0"],
  chart: ["M3 3v16a2 2 0 0 0 2 2h16", "m7 14 3.5-4.5 3 2.5L18 7"],
  table: ["M4 5h16v14H4z", "M4 10h16", "M10 10v9"],
  clock: ["M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0", "M12 7.5V12l3 1.8"],
  external: ["M14 4h6v6", "M20 4 11 13", "M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"],
  chevron: ["m8 10 4 4 4-4"],
  alert: ["M12 4 2.6 20h18.8z", "M12 10v4", "M12 17.2v.1"],
  layers: ["m12 3 9 5-9 5-9-5z", "m3 13 9 5 9-5", "m3 17.5 9 5 9-5"],
} as const

export type IconName = keyof typeof paths

export const Icon = ({ name, size = 16 }: { name: IconName; size?: number }) => (
  <svg
    className="icon"
    viewBox="0 0 24 24"
    width={size}
    height={size}
    fill="none"
    stroke="currentColor"
    strokeWidth={1.7}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {paths[name].map((d) => (
      <path key={d} d={d} />
    ))}
  </svg>
)
