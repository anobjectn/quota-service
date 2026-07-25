# Repository agent guidance

## Keep the local service running

Assume the user normally relies on quota-service at `http://127.0.0.1:8787`.

- Before starting or stopping the server, check whether the service is already reachable on port `8787`.
- Reuse a healthy running service. Do not restart it merely to run checks or pick up unrelated changes.
- Never use broad process-kill commands. If the service must be replaced, target only the process started for this repository.
- Prefer checks that do not stop the shared service. Keep temporary test servers separate from it and use a different port.
- At the end of implementation work, leave the service reachable. If it was running when work began, preserve it; if work or prior agent activity left it stopped, start `bun run serve` and leave it running unless the user explicitly asks otherwise.
- Report the final local URL and whether the service was preserved, restarted, or started.
