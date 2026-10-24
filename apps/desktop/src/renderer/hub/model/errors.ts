/** Electron prefixes IPC failures with "Error invoking remote method 'x': Error: "; keep the cause. */
export function ipcErrorMessage(e: unknown): string {
  const raw = String((e as Error)?.message ?? e);
  return raw.replace(
    /^Error invoking remote method '[^']+': (?:\w*Error: )?/,
    "",
  );
}
