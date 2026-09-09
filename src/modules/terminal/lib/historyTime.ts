const monthDay = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });

export function formatHistoryTime(value: string, now = new Date()): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Time unavailable";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const day = date.toDateString() === now.toDateString()
    ? "today"
    : date.toDateString() === yesterday.toDateString()
      ? "yesterday"
      : monthDay.format(date);
  return `${day} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
