import type { CSSProperties } from "react";
const paths = {
  temperature: "M10 14.8V5a2 2 0 0 1 4 0v9.8a4 4 0 1 1-4 0ZM12 8v9m-1 2h2",
  humidity:
    "M12 3C9 7 5 11 5 15a7 7 0 0 0 14 0c0-4-4-8-7-12ZM9 16a3 3 0 0 0 3 3",
  sound: "M4 10v4m4-7v10m4-13v16m4-13v10m4-7v4",
  safety: "M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3Zm-4 9 3 3 5-6",
  scan: "M4 8V4h4m8 0h4v4m0 8v4h-4M8 20H4v-4M8 12h8m-4-4v8",
  photo: "M4 7h4l2-3h4l2 3h4v13H4V7Zm12 6a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z",
  arrow: "M5 12h14m-5-5 5 5-5 5",
  rack: "M5 3h14v8H5V3Zm0 10h14v8H5v-8Zm3-6h1m3 0h4m-8 10h1m3 0h4",
  fleet: "M4 5h6v6H4V5Zm10 0h6v6h-6V5ZM9 15h6v6H9v-6Zm-2-4v2h10v-2m-5 2v2",
  clock: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9-5v5l3 2",
  check: "m5 12 4 4L19 6",
  alert: "m12 3 10 18H2L12 3Zm0 6v5m0 3v.1",
  chevron: "m9 5 7 7-7 7",
} as const;
export type IconName = keyof typeof paths;
export default function Icon({
  name,
  size = 20,
  style,
}: {
  name: IconName;
  size?: number;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={style}
    >
      <path d={paths[name]} />
    </svg>
  );
}
