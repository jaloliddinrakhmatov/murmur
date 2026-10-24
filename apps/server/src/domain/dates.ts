const DAY_MS = 86_400_000;

export const addDays = (d: Date, n: number): Date =>
  new Date(d.getTime() + n * DAY_MS);

/** Calendar months in UTC; a day that doesn't exist in the target month moves to its last day. */
export function addMonths(d: Date, n: number): Date {
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
  const last = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  return new Date(
    Date.UTC(
      target.getUTCFullYear(),
      target.getUTCMonth(),
      Math.min(d.getUTCDate(), last),
      d.getUTCHours(),
      d.getUTCMinutes(),
      d.getUTCSeconds(),
      d.getUTCMilliseconds(),
    ),
  );
}
