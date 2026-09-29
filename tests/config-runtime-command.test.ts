import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as configModule from "../src/config";

function writeConfig(appHome: string, runtimeCommand: string[]): void {
  writeFileSync(join(appHome, "config.json"), `${JSON.stringify({
    version: 3,
    releaseVersion: "0.2.0",
    mode: "browser-only",
    host: "127.0.0.1",
    port: 17841,
    contextWindow: 256_000,
    appName: "Codex Native",
    browserHost: "managed-chrome",
    chromeExecutablePath: process.execPath,
    storageStatePath: join(appHome, "browser", "storage-state.json"),
    brokerSocketPath: join(appHome, "runtime", "turn-broker.sock"),
    headed: true,
    solAvailable: true, extraHighAvailable: false, proAvailable: false,
    autoApproveToolCalls: false,
    controlToken: "runtime-control-token-0123456789abcdef0123456789",
    runtimeCommand,
  })}\n`);
}

function withAppHome(test: (appHome: string) => void | Promise<unknown>): () => Promise<void> {
  return async () => {
    const appHome = mkdtempSync(join(tmpdir(), "codex-web-config-heal-"));
    const previousHome = process.env.CODEX_CHATGPT_WEB_HOME;
    const previousBun = process.env.CODEX_CHATGPT_WEB_BUN;
    process.env.CODEX_CHATGPT_WEB_HOME = appHome;
    process.env.CODEX_CHATGPT_WEB_BUN = process.execPath;
    try {
      await test(appHome);
    } finally {
      if (previousHome === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME;
      else process.env.CODEX_CHATGPT_WEB_HOME = previousHome;
      if (previousBun === undefined) delete process.env.CODEX_CHATGPT_WEB_BUN;
      else process.env.CODEX_CHATGPT_WEB_BUN = previousBun;
      rmSync(appHome, { recursive: true, force: true });
    }
  };
}

test("loadConfig re-resolves a runtime command whose executable no longer exists",
  withAppHome((appHome) => {
    writeConfig(appHome, [join(appHome, "gone", "bin", "bun"), join(appHome, "gone", "cli.ts")]);
    const config = configModule.loadConfig();
    expect(config.runtimeCommand[0]).toBe(resolve(process.execPath));
  }));

test("loadConfig keeps a durable runtime command unchanged",
  withAppHome((appHome) => {
    writeConfig(appHome, [process.execPath]);
    const config = configModule.loadConfig();
    expect(config.runtimeCommand).toEqual([process.execPath]);
  }));
