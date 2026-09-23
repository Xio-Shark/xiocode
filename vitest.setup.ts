import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Every vitest worker gets one throwaway HOME for its whole lifetime.
//
// Tests that build an env as `{ ...process.env }` used to inherit the
// developer's real HOME, so `prepareSession` wrote trust entries into the real
// `~/.xiocode/trust.json` (322 dead temp-directory entries had accumulated) and
// `/api/settings` rewrote the real `~/.xiocode/config.toml`. Isolating HOME here
// keeps that class of leak from coming back through a new test.
const MARKER = "__XIO_TEST_HOME__";

if (!process.env[MARKER]) {
  const home = mkdtempSync(path.join(os.tmpdir(), "xio-vitest-home-"));
  process.env.HOME = home;
  process.env.XIO_HOME = path.join(home, ".xiocode");
  process.env[MARKER] = home;
  process.once("exit", () => {
    rmSync(home, { recursive: true, force: true });
  });
}
