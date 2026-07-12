// Read-only macOS keychain access. Never writes, never logs the secret value.
// First read from a new binary triggers a one-time "always allow" prompt;
// if Luis denies it (or it's non-interactive, e.g. launchd), the read fails
// and the caller must degrade to a stale state rather than crash.

export interface KeychainReadResult {
  ok: boolean;
  value?: string;
  /** true if the failure looks like a user-denied or non-interactive prompt */
  denied?: boolean;
  error?: string;
}

export async function readGenericPassword(
  service: string,
): Promise<KeychainReadResult> {
  try {
    const proc = Bun.spawn(
      ["security", "find-generic-password", "-s", service, "-w"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      const denied = /interaction is not allowed|user denied|-25293|-25308/i.test(
        stderr,
      );
      return { ok: false, denied, error: stderr.trim() || `exit ${exitCode}` };
    }
    const value = stdout.trim();
    if (!value) {
      return { ok: false, error: "empty keychain value" };
    }
    return { ok: true, value };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
