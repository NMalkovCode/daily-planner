// Helpers for the "YYYY-MM-DD" date strings used throughout the app.
// Dates are handled as local calendar days, never as UTC instants.

export function parseDate(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function formatDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function addDays(s: string, days: number): string {
  const d = parseDate(s);
  d.setDate(d.getDate() + days);
  return formatDate(d);
}

export function todayString(): string {
  return formatDate(new Date());
}
