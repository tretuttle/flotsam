import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { BINARY_ENV, parseCommand } from "./cli.ts";

const executable = process.execPath;

describe("command line", () => {
  it("requires a browser binary on every platform and names both ways to give it", () => {
    expect(() => parseCommand(["measure"], {})).toThrow(
      `a browser binary is required: pass --binary <path> or set ${BINARY_ENV}`,
    );
    expect(() => parseCommand(["baseline", "--runs", "2"], {})).toThrow(
      /browser binary is required/,
    );
  });

  it("refuses a binary that does not exist", () => {
    const missing = NodePath.resolve("no-such-browser-binary");
    expect(() => parseCommand(["measure", "--binary", missing], {})).toThrow(
      `browser binary not found or not executable: ${missing}`,
    );
  });

  it("takes the binary from the environment, runs headless by default and shows a window only when asked", () => {
    expect(parseCommand(["measure"], { [BINARY_ENV]: executable })).toMatchObject({
      kind: "measure",
      binaryPath: executable,
      display: "headless",
    });
    expect(
      parseCommand(["--", "baseline", "--binary", executable, "--show-window"], {}),
    ).toMatchObject({ kind: "baseline", binaryPath: executable, display: "window" });
  });

  it("needs a scenario for har-check", () => {
    expect(() => parseCommand(["har-check", "capture.har"], {})).toThrow(
      /har-check needs --scenario/,
    );
    expect(parseCommand(["har-check", "--scenario", "page", "capture.har"], {})).toEqual({
      kind: "har-check",
      scenario: "page",
      file: "capture.har",
    });
  });
});
