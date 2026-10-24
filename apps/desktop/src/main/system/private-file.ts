import { chmod, writeFile } from "node:fs/promises";

/**
 * Writes a file only its owner can read. writeFile's mode applies only to a file it creates, so
 * an existing file the person chose to overwrite is set to 0600 afterwards as well.
 */
export async function writePrivateFile(
  path: string,
  data: string,
): Promise<void> {
  await writeFile(path, data, { mode: 0o600 });
  await chmod(path, 0o600);
}
