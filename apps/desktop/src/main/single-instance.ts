// Only the first Murmur runs. A second launch must exit before start-up does anything: the
// start-up work (unmuting, recovering meetings, opening the database) belongs to the running one.

/** True when this process is the one to run: a throwaway test run, or the one that got the lock. */
export function ownsApp(
  throwaway: boolean,
  requestLock: () => boolean,
): boolean {
  return throwaway || requestLock();
}
