/** Formats a Unix timestamp in seconds, e.g. "Sun, Mar 15, 2026, 12:00 PM". */
export function formatDateTime(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const relativeFormat = new Intl.RelativeTimeFormat(undefined, {
  numeric: "auto",
});
const units: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 31_536_000],
  ["month", 2_592_000],
  ["week", 604_800],
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
];

/** Formats a Unix timestamp in seconds relative to now, e.g. "5 minutes ago". */
export function formatRelative(timestamp: number): string {
  const seconds = timestamp - Date.now() / 1000;
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) {
      return relativeFormat.format(Math.round(seconds / size), unit);
    }
  }
  return "just now";
}
