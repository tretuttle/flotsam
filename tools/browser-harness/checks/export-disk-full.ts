import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { CheckContext, CheckResult, HarnessCheck } from "../src/checks.ts";
import { judgeDiskFull, type DiskFullObservation } from "../src/export-judge.ts";
import {
  ended,
  newestPageTab,
  openExtensionPage,
  startExport,
  waitForJob,
} from "../src/export-session.ts";
import { FIXTURES_PAGE_PATH } from "../src/fixtures.ts";
import { recordingWorkspace } from "../src/recording-session.ts";
import { startFixtureServer } from "../src/server.ts";

const NAME = "export-disk-full";
const TMPFS_BYTES = 8 * 1_048_576;

/**
 * The browser runs in its own user and mount namespace with a size-limited tmpfs over its Downloads folder, so the
 * export meets the kernel's own ENOSPC; nothing in the product is replaced. Every command in the chain execs, so the
 * process the harness started, owns and stops is the browser itself. No PID namespace: nothing here sends a signal.
 */
const wrapper = (binary: string, folder: string): string => `#!/bin/sh
exec unshare --user --map-root-user --mount -- /bin/sh -c 'mount -t tmpfs -o size=${String(TMPFS_BYTES)} one-click-har-full "$0" && exec "$@"' ${JSON.stringify(folder)} ${JSON.stringify(binary)} "$@"
`;

const CHROME_LIST = `const done = arguments[arguments.length - 1];
(async () => {
  const [folder, size] = arguments;
  const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  file.initWithPath(folder);
  done({
    children: (await IOUtils.getChildren(folder)).map((path) => PathUtils.filename(path)),
    tmpfs: file.diskCapacity === size,
    capacity: file.diskCapacity,
  });
})().catch((error) => done({ error: String(error) }));`;

const namespacesRefused = (): string | null => {
  const probe = NodeChildProcess.spawnSync(
    "unshare",
    ["--user", "--map-root-user", "--mount", "true"],
    {
      encoding: "utf8",
    },
  );
  return probe.status === 0 ? null : (probe.stderr || String(probe.error)).trim();
};

/**
 * An export into a full volume ends write-failed with disk-full, the bytes the refused write needed and the free bytes
 * the volume reported, and leaves neither the .har nor its .har.part. Planted: an export that finished, and a
 * failure reported without numbers, must fail the same judge.
 */
const check: HarnessCheck = {
  name: NAME,
  description: "a full disk gives write-failed with needBytes and freeBytes and leaves no file",
  run: async (context: CheckContext): Promise<CheckResult> => {
    const started = Date.now();
    const finish = (problems: readonly string[], detail: string, data?: unknown): CheckResult => ({
      name: NAME,
      ok: problems.length === 0,
      durationMs: Date.now() - started,
      detail: problems.length === 0 ? detail : problems.join("; "),
      data,
    });
    if (context.extensionPath === null) return finish(["needs --extension"], "");
    const refused = namespacesRefused();
    if (refused !== null) {
      if (process.env.CI)
        return finish([`a user and mount namespace is needed and was refused: ${refused}`], "");
      return finish([], `skipped: this machine refused a user and mount namespace (${refused})`);
    }
    await using server = await startFixtureServer();
    await using workspace = recordingWorkspace("export-disk-full");
    const launcher = NodePath.join(
      NodePath.dirname(workspace.downloads),
      "browser-on-full-disk.sh",
    );
    NodeFS.writeFileSync(launcher, wrapper(context.binaryPath, workspace.downloads), {
      mode: 0o700,
    });
    await using session = await workspace.launch({
      binaryPath: launcher,
      extensionPath: context.extensionPath,
      display: context.display,
      protocol: "marionette",
      signal: context.signal,
    });
    const page = await openExtensionPage(session, context.extensionPath);
    const tab = await session.openTab(`${server.origin}${FIXTURES_PAGE_PATH}`);
    await session.evaluate(tab, "window.__harnessReady");
    const tabId = await newestPageTab(page);
    const job = await startExport(page, {
      selection: { scope: "tab", tabId, range: { kind: "since-tab-opened" }, include: "all" },
      bodies: "include",
      redaction: "standard",
      packaging: "har",
      fileName: "full",
    });
    const final = await waitForJob(page, job.id, ended);
    const seen = (await session.evaluateChrome(CHROME_LIST, [workspace.downloads, TMPFS_BYTES])) as
      | { readonly children: readonly string[]; readonly tmpfs: boolean }
      | { readonly error: string };
    if ("error" in seen) return finish([`listing the full folder: ${seen.error}`], "");
    const journal = NodePath.join(workspace.root(), "exports.jsonl");
    const observation: DiskFullObservation = {
      state: final.state,
      tmpfs: seen.tmpfs,
      left: seen.children,
      journal: NodeFS.existsSync(journal) ? NodeFS.readFileSync(journal, "utf8") : "",
    };
    const problems = [...judgeDiskFull(observation)];
    const planted = [
      { ...observation, state: { kind: "done" } },
      { ...observation, state: { kind: "write-failed", failure: { kind: "other" } } },
    ].filter((p) => judgeDiskFull(p).length === 0);
    if (planted.length > 0)
      problems.push(`planted disk-full failures passed: ${JSON.stringify(planted)}`);
    return finish(
      problems,
      `${JSON.stringify(final.state)} on a ${String(TMPFS_BYTES)} byte tmpfs; folder left empty; journal ended; planted finished export and failure without numbers caught`,
      observation,
    );
  },
};

/** @discovered-check */
export default check;
