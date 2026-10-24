/**
 * Runs async command handlers one at a time, in arrival order. Without this, a "cancel" that
 * arrives while getUserMedia is still pending tears down nothing, and the start then completes
 * anyway: the microphone stays on and an AudioContext leaks (verified: after a few rapid
 * press-and-cancel cycles, new starts timed out).
 */
export function serial<T>(
  handle: (command: T) => Promise<void>,
): (command: T) => Promise<void> {
  let tail: Promise<void> = Promise.resolve();
  return (command) => {
    const run = tail.then(() => handle(command));
    tail = run.catch(() => {});
    return run;
  };
}
