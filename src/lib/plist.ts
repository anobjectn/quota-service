// Read-only macOS `defaults` (cfprefsd) access. Warp stores AIRequestLimitInfo
// as a JSON-encoded string value, so `defaults read <domain> <key>` prints
// valid JSON directly to stdout (verified live on this machine) — no need to
// export the whole domain or shell out to plutil, which chokes on unrelated
// binary values elsewhere in Warp's preference domain.

export interface PlistReadResult {
  ok: boolean;
  value?: unknown;
  error?: string;
}

export async function readDefaultsKeyAsJson(
  domain: string,
  key: string,
): Promise<PlistReadResult> {
  try {
    const proc = Bun.spawn(["defaults", "read", domain, key], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      return { ok: false, error: stderr.trim() || `defaults read exit ${exitCode}` };
    }
    const text = stdout.trim();
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch (parseErr) {
      return {
        ok: false,
        error: `key "${key}" in domain "${domain}" is not JSON: ${
          parseErr instanceof Error ? parseErr.message : String(parseErr)
        }`,
      };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** mtime (ms) of the backing plist file, used as a data-age signal when Warp isn't running. */
export async function domainPlistMtimeMs(domain: string): Promise<number | null> {
  try {
    const path = `${process.env.HOME}/Library/Preferences/${domain}.plist`;
    const file = Bun.file(path);
    if (!(await file.exists())) return null;
    const stat = await file.stat();
    return stat.mtime.getTime();
  } catch {
    return null;
  }
}
