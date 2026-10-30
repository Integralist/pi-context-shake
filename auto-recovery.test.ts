import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import shakeExtension from "./index.ts";
import { spawnSync } from "node:child_process";
import { createAutoRecovery } from "./auto-recovery.ts";

const cleanup: string[] = [];
afterEach(() => { for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "shake-auto-test-"));
  cleanup.push(dir);
  const file = join(dir, "session.jsonl");
  writeFileSync(file, '{"type":"session","id":"session"}\n');
  const handlers = new Map<string, any>();
  const entries: any[] = [];
  const sent: { text: string; options: any }[] = [];
  const notices: string[] = [];
  let percent: number | null = 49;
  let idle = false;
  let pending = false;
  let leaf = "leaf";
  let rebuilds = 0;
  let rebuildOK = true;
  let aborted = 0;
  let gitFailed = false;
  const aborter = new AbortController();
  let gitHook: (() => void) | undefined;
  const pi = {
    exec: async (_command: string, args: string[]) => {
      const callback = gitHook; gitHook = undefined; callback?.();
      if (args.includes("config") && !gitFailed) return { code: 1, stdout: "", stderr: "" };
      return { code: gitFailed ? 1 : 0,
        stdout: args.at(-1) === "HEAD" ? "abc123\\n" : "clean fixture\\n", stderr: "" };
    },
    on: (name: string, handler: any) => handlers.set(name, handler),
    appendEntry: (customType: string, data: any) => {
      entries.push({ type: "custom", customType, data });
    },
    sendUserMessage: (text: string, options: any) => sent.push({ text, options }),
  };
  const ctx = {
    mode: "print", hasUI: false, cwd: dir, signal: aborter.signal,
    ui: { notify: (text: string) => notices.push(text) },
    isIdle: () => idle, hasPendingMessages: () => pending,
    waitForIdle: async () => { idle = true; },
    abort: () => { aborted++; },
    getContextUsage: () => ({ percent, tokens: percent === null ? null : percent * 1000, contextWindow: 100000 }),
    sessionManager: {
      getSessionId: () => "session", getSessionFile: () => file,
      getLeafId: () => leaf, getBranch: () => entries, getEntries: () => entries,
      buildSessionProjection: () => ({ messages: [] }),
    },
  };
  const auto = createAutoRecovery(pi as never, async () => {
    expect(idle).toBe(true);
    rebuilds++;
    if (rebuildOK) writeFileSync(file, "shaken\n");
    return rebuildOK;
  });
  const event = () => ({ outcome: "completed", continue: false, entries: [],
    message: [...entries].reverse().find(entry => entry.type === "message")?.message,
    context: { canContinue: true, pendingMessages: [], contextMessages: [] } });
  async function emit(name: string, value: any = event()) {
    return await handlers.get(name)?.(value, ctx);
  }
  async function request() {
    await auto.command("on", ctx as never);
    percent = 50;
    const result = await emit("turn_end");
    const text = result?.entries?.find((e: any) => e.customType === "pi-shake-checkpoint")?.content;
    expect(typeof text).toBe("string");
    const path = text.match(/Checkpoint file: (.+)/)?.[1];
    const nonce = text.match(/SHAKE_READY ([a-f0-9-]+)/)?.[1];
    expect(path).toBeTruthy(); expect(nonce).toBeTruthy();
    cleanup.push(join(path, ".."));
    return { result, path, nonce, text };
  }
  function checkpoint(path: string, nonce: string, patch: any = {}) {
    writeFileSync(path, JSON.stringify({
      version: 1, nonce, sessionId: "session", cwd: dir, safeToResume: true,
      request: "Implement the approved plan", scope: "Only the named feature",
      authority: "interactive; approved implementation only; do not commit on main",
      artifacts: ["execution.md", "plan.md"], progress: "Task 1 verified",
      evidence: "Test logs and reviewed snapshot are recorded in execution.md",
      gitState: "main; baseline abc; no commit to repeat",
      activeSubagents: [], activeProcesses: [], blockers: [],
      nextAction: "Read execution.md and start task 2",
      ...patch,
    }));
  }
  function answer(text: string) {
    entries.push({ type: "message", message: { role: "assistant", content: [{ type: "text", text }],
      usage: { input: 10000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 10100 } } });
  }
  async function ready(path: string, nonce: string, patch: any = {}) {
    checkpoint(path, nonce, patch); answer("SHAKE_READY " + nonce);
    await emit("agent_before_settle");
    const command = sent.find(item => item.options?.expandPromptTemplates)?.text;
    if (command) {
      await auto.command(command.replace("/shake auto ", ""), ctx as never);
      answer("SHAKE_RELOADED " + nonce);
    }
  }
  return { auto, ctx, dir, file, sent, notices, entries, emit, event, request, ready, answer, checkpoint,
    setPercent: (value: number | null) => { percent = value; },
    setPending: (value: boolean) => { pending = value; },
    setLeaf: (value: string) => { leaf = value; },
    setRebuildOK: (value: boolean) => { rebuildOK = value; },
    setGitFailed: () => { gitFailed = true; },
    duringGit: (callback: () => void) => { gitHook = callback; },
    abortSignal: () => aborter.abort(),
    rebuilds: () => rebuilds, aborted: () => aborted };
}

const currentSDK = process.env.CURRENT_SDK_ROOT;
describe.skipIf(!currentSDK)("real current Pi host", () => {
  test("checkpoints, backs up, shakes, verifies fresh usage, and resumes without another user prompt", async () => {
    const sdk = await import(pathToFileURL(join(currentSDK!, "dist/index.js")).href);
    const nestedAI = join(currentSDK!, "node_modules/@earendil-works/pi-ai/dist/index.js");
    const ai = await import(pathToFileURL(existsSync(nestedAI) ? nestedAI :
      join(dirname(currentSDK!), "pi-ai/dist/index.js")).href);
    const dir = mkdtempSync(join(tmpdir(), "shake-auto-sdk-")); cleanup.push(dir);
    writeFileSync(join(dir, "execution.md"), "Interactive mode; original approval only; task 1 verified.\\n");
    for (const args of [["init", "-q", "-b", "main"], ["add", "execution.md"],
      ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
        "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "baseline"]]) {
      const git = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
      expect(git.status).toBe(0);
    }
    const filterMarker = join(dir, ".git", "filter-ran");
    writeFileSync(join(dir, ".gitattributes"), "execution.md filter=recovery-test\n");
    const config = spawnSync("git", ["config", "filter.recovery-test.clean",
      'sh -c \'printf invoked > "$1"; cat\' filter-test "' + filterMarker + '"'],
      { cwd: dir, encoding: "utf8" });
    expect(config.status).toBe(0);
    writeFileSync(join(dir, "execution.md"),
      "Interactive mode; original approval only; task 1 verified. Updated.\n");
    const runtime = await sdk.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(),
      modelsStore: new ai.InMemoryModelsStore(), modelsPath: null,
      refreshOnCreate: false, allowModelNetwork: false });
    for (const provider of runtime.getProviders()) runtime.registerNativeProvider({ ...provider,
      auth: { apiKey: { name: "Offline", resolve: async () => undefined } }, filterModels: () => [] });
    const provider = ai.fauxProvider({ provider: "shake-auto-offline", api: "openai-completions",
      models: [{ id: "test", contextWindow: 100000 }], tokensPerSecond: 1000000 });
    runtime.registerNativeProvider(provider.provider);
    let manager = sdk.SessionManager.inMemory(dir);
    manager.appendMessage({ role: "user", content: "old history ".repeat(9000), timestamp: 1 });
    manager.appendMessage(ai.fauxAssistantMessage("old reply ".repeat(2000)));
    manager.appendCustomEntry("pi-shake", { modes: { tools: false, images: false, thinking: false } });
    const sessionFile = join(dir, "session.jsonl");
    writeFileSync(sessionFile, [manager.getHeader(), ...manager.getEntries()]
      .map(entry => JSON.stringify(entry)).join("\n") + "\n", { mode: 0o600 });
    manager = sdk.SessionManager.open(sessionFile);
    const settings = sdk.SettingsManager.inMemory({ compaction: { enabled: false },
      retry: { enabled: false }, cacheWarming: "off" });
    const loader = new sdk.DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [shakeExtension] });
    await loader.reload();
    const { session } = await sdk.createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime,
      settingsManager: settings, sessionManager: manager, resourceLoader: loader,
      tools: ["read"], model: runtime.getModel("shake-auto-offline", "test") });
    const errors: string[] = []; const notices: string[] = [];
    await session.bindExtensions({ mode: "print",
      commandContextActions: { waitForIdle: () => session.waitForIdle() },
      uiContext: { notify: (text: string) => notices.push(text), setWidget: () => {} },
      onError: (error: any) => errors.push(error.error) });
    await runtime.refresh({ allowNetwork: false });
    let checkpointPath = ""; let nonce = "";
    const response = (text: string, total: number) => ({
      ...ai.fauxAssistantMessage(text),
      usage: { input: total, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: total + 1,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    });
    provider.setResponses([
      () => response("Task 1 verified; ready for next task.", 60000),
      (context: any) => {
        const dump = JSON.stringify(context.messages).replace(/\\n/g, "\n");
        checkpointPath = dump.match(/Checkpoint file: ([^\n"]+)/)?.[1] ?? "";
        nonce = dump.match(/SHAKE_READY ([a-f0-9-]+)/)?.[1] ?? "";
        expect(checkpointPath).toBeTruthy(); cleanup.push(dirname(checkpointPath));
        const data = JSON.parse(readFileSync(checkpointPath, "utf8"));
        for (const key of ["request", "scope", "authority", "progress", "evidence", "gitState", "nextAction"])
          data[key] = "Verified " + key + "; do not repeat task 1";
        data.artifacts = ["execution.md"]; data.safeToResume = true;
        writeFileSync(checkpointPath, JSON.stringify(data));
        return response("SHAKE_READY " + nonce, 60000);
      },
      (context: any) => {
        expect(JSON.stringify(context.messages)).toContain("Git snapshot");
        return ai.fauxAssistantMessage([
          { type: "toolCall", id: "read-checkpoint", name: "read", arguments: { path: checkpointPath } },
          { type: "toolCall", id: "read-execution", name: "read", arguments: { path: join(dir, "execution.md") } },
        ], { stopReason: "toolUse" });
      },
      (context: any) => {
        const results = context.messages.filter((message: any) => message.role === "toolResult");
        expect(results.length).toBe(2);
        expect(results.every((message: any) => !message.isError)).toBe(true);
        expect(JSON.stringify(results)).toContain("original approval only");
        return response("SHAKE_RELOADED " + nonce, 30000);
      },
      () => response("Resumed task 2 without replaying task 1.", 30000),
    ]);
    try {
      await session.prompt("/shake auto on");
      await session.prompt("Execute the approved plan");
      const deadline = Date.now() + 5000;
      while (provider.state.callCount < 5 && Date.now() < deadline)
        await new Promise(resolve => setTimeout(resolve, 10));
      await session.waitForIdle();
      expect(errors).toEqual([]);
      expect({ calls: provider.state.callCount, notices, last: session.getLastAssistantText(),
        usage: session.getContextUsage(), actual: session.messages.at(-1)?.usage })
        .toMatchObject({ calls: 5 });
      expect(session.getLastAssistantText()).toContain("Resumed task 2");
      expect(readFileSync(join(dirname(checkpointPath), "session-backup.jsonl"), "utf8"))
        .toContain("old history old history");
      expect(statSync(sessionFile).mode & 0o777).toBe(0o600);
      expect(notices.some(text => text.includes("stopped"))).toBe(false);
      expect(existsSync(filterMarker)).toBe(false);
      expect(manager.getBranch().some((entry: any) =>
        typeof entry.message?.content === "string" && entry.message.content.startsWith("old history"))).toBe(true);
      expect(manager.getBranch().some((entry: any) =>
        entry.message?.content?.some?.((block: any) => block.text?.includes("Resumed task 2")))).toBe(true);
    } finally { session.dispose(); }
  }, 15000);
});

describe("opt-in context recovery", () => {
  test("does nothing by default or below 50 percent", async () => {
    const f = fixture();
    f.setPercent(80);
    expect(await f.emit("turn_end")).toBeUndefined();
    await f.auto.command("on", f.ctx as never);
    f.setPercent(49);
    expect(await f.emit("turn_end")).toBeUndefined();
    expect(f.rebuilds()).toBe(0);
  });

  test("can append the checkpoint after a final assistant response", async () => {
    const f = fixture(); await f.auto.command("on", f.ctx as never);
    f.setPercent(50); const event = f.event(); event.context.canContinue = false;
    const result = await f.emit("turn_end", event);
    expect(result?.continue).toBe(true);
    cleanup.push(join(result.entries.at(-1).content.match(/Checkpoint file: (.+)/)[1], ".."));
  });

  test("requests one checkpoint at 50, preserving other boundary entries", async () => {
    const f = fixture(); await f.auto.command("on", f.ctx as never);
    f.setPercent(50);
    const event = f.event(); event.entries.push({ type: "custom", customType: "another" } as never);
    const result = await f.emit("turn_end", event);
    expect(result.continue).toBe(true);
    expect(result.entries[0].customType).toBe("another");
    const text = result.entries[1].content;
    expect(text).toContain("active subagents"); expect(text).toContain("approvals");
    cleanup.push(join(text.match(/Checkpoint file: (.+)/)[1], ".."));
    expect(await f.emit("turn_end")).toBeUndefined();
    expect(f.rebuilds()).toBe(0);
  });

  test("backs up original bytes privately, rebuilds only idle, then reloads read-only", async () => {
    const f = fixture(); const { path, nonce } = await f.request();
    await f.ready(path, nonce);
    expect(f.rebuilds()).toBe(1);
    expect(readFileSync(join(path, "..", "session-backup.jsonl"), "utf8"))
      .toBe('{"type":"session","id":"session"}\n');
    expect(statSync(join(path, "..", "session-backup.jsonl")).mode & 0o777).toBe(0o600);
    expect(f.sent[0]?.options.expandPromptTemplates).toBe(true);
    expect(f.sent.at(-1)?.text).toContain("Read-only recovery");
    expect(f.sent.at(-1)?.text).toContain(path);
    expect(f.auto.status()).toBe("verifying");
    f.setPercent(35);
    const result = await f.emit("turn_end");
    expect(result.continue).toBe(true);
    expect(result.entries[0].content).toContain("Resume");
    expect(f.auto.status()).toBe("armed");
  });

  test.each([
    ["unsafe checkpoint", { safeToResume: false }],
    ["active subagent", { activeSubagents: ["worker"] }],
    ["active process", { activeProcesses: ["test-runner"] }],
    ["missing authority", { authority: "" }],
    ["wrong session", { sessionId: "other" }],
    ["wrong nonce", { nonce: "other" }],
    ["blocker", { blockers: ["required access unavailable"] }],
  ])("hands off instead of shaking: %s", async (_name, patch) => {
    const f = fixture(); const { path, nonce } = await f.request();
    await f.ready(path, nonce, patch);
    expect(f.rebuilds()).toBe(0);
    expect(f.auto.status()).toBe("blocked");
    expect(readFileSync(join(path, "..", "handoff.md"), "utf8")).toContain(path);
  });

  test("does not recover on an absent acknowledgement, malformed checkpoint, or user queue", async () => {
    for (const reason of ["ack", "json", "queue"]) {
      const f = fixture(); const { path, nonce } = await f.request();
      if (reason === "json") { writeFileSync(path, "{"); f.answer("SHAKE_READY " + nonce); }
      if (reason === "queue") { f.checkpoint(path, nonce); f.answer("SHAKE_READY " + nonce); f.setPending(true); }
      await f.emit("agent_before_settle");
      expect(f.rebuilds()).toBe(0);
      expect(f.auto.status()).toBe("blocked");
    }
  });

  test("refuses stale dispatch after new input, shutdown, or leaf change", async () => {
    for (const change of ["input", "session_shutdown", "leaf"]) {
      const f = fixture(); const { path, nonce } = await f.request();
      f.checkpoint(path, nonce); f.answer("SHAKE_READY " + nonce);
      await f.emit("agent_before_settle");
      const dispatch = f.sent[0]?.text;
      expect(dispatch).toBeTruthy();
      if (change === "leaf") f.setLeaf("different");
      else await f.emit(change, {});
      await f.auto.command(dispatch!.replace("/shake auto ", ""), f.ctx as never);
      expect(f.rebuilds()).toBe(0);
    }
  });

  test.each([50, 70, null])("hands off when fresh post-shake usage is %s", async (usage) => {
    const f = fixture(); const { path, nonce } = await f.request(); await f.ready(path, nonce);
    f.setPercent(usage);
    await f.emit("turn_end");
    expect(f.auto.status()).toBe("blocked");
    expect(f.rebuilds()).toBe(1);
    expect(readFileSync(join(path, "..", "handoff.md"), "utf8")).toContain("Suggested skills");
    await f.emit("turn_end");
    expect(f.rebuilds()).toBe(1);
  });

  test("uses hysteresis: no second shake until fresh usage falls below 40", async () => {
    const f = fixture(); const { path, nonce } = await f.request(); await f.ready(path, nonce);
    f.setPercent(45); await f.emit("turn_end");
    expect(f.auto.status()).toBe("cooldown");
    f.setPercent(51); await f.emit("turn_end");
    expect(f.auto.status()).toBe("blocked");
    expect(f.rebuilds()).toBe(1);
  });

  test("rebuild failure preserves the backup and writes handoff", async () => {
    const f = fixture(); const { path, nonce } = await f.request();
    f.setRebuildOK(false); await f.ready(path, nonce);
    expect(f.auto.status()).toBe("blocked");
    expect(readFileSync(join(path, "..", "session-backup.jsonl"), "utf8")).toContain('"id":"session"');
    expect(readdirSync(join(path, ".."))).toContain("handoff.md");
  });

  test("accepts only its own internal reload input, not another extension's message", async () => {
    const f = fixture(); const { path, nonce } = await f.request(); await f.ready(path, nonce);
    const reload = f.sent.at(-1)!.text;
    await f.emit("input", { source: "extension", text: reload });
    expect(f.auto.status()).toBe("verifying");
    await f.emit("input", { source: "extension", text: "unrelated extension message" });
    expect(f.auto.status()).toBe("blocked");
  });

  test("refuses unsupported and ephemeral hosts without rewriting", async () => {
    const f = fixture();
    (f.ctx.sessionManager as any).buildSessionProjection = undefined;
    await f.auto.command("on", f.ctx as never);
    expect(f.auto.status()).toBe("off");
    expect(f.notices.at(-1)).toContain("requires");
    const g = fixture(); await g.auto.command("on", g.ctx as never);
    (g.ctx.sessionManager as any).getSessionFile = () => undefined;
    g.setPercent(50); await g.emit("turn_end");
    expect(g.auto.status()).toBe("blocked");
    expect(g.rebuilds()).toBe(0);
  });

  test("read-only reload blocks mutations and accepts read tools", async () => {
    const f = fixture(); const { path, nonce } = await f.request(); await f.ready(path, nonce);
    expect(await f.emit("tool_call", { toolName: "read" })).toBeUndefined();
    expect((await f.emit("tool_call", { toolName: "write" })).block).toBe(true);
    expect((await f.emit("tool_call", { toolName: "bash" })).block).toBe(true);
    await f.emit("agent_before_settle");
    expect(f.auto.status()).toBe("blocked");
  });

  test("a changed checkpoint cannot release the read-only continuation", async () => {
    const f = fixture(); const { path, nonce } = await f.request(); await f.ready(path, nonce);
    f.checkpoint(path, nonce, { nextAction: "changed next action" });
    f.setPercent(30); await f.emit("turn_end");
    expect(f.auto.status()).toBe("blocked");
  });

  test("refuses abandoned branches and a preexisting backup", async () => {
    for (const reason of ["branch", "backup"]) {
      const f = fixture(); const { path, nonce } = await f.request();
      if (reason === "branch") {
        const getEntries = f.ctx.sessionManager.getEntries;
        (f.ctx.sessionManager as any).getEntries = () => [...getEntries(), { id: "abandoned", type: "message" }];
      } else writeFileSync(join(path, "..", "session-backup.jsonl"), "original backup");
      await f.ready(path, nonce);
      expect(f.auto.status()).toBe("blocked"); expect(f.rebuilds()).toBe(0);
      if (reason === "backup")
        expect(readFileSync(join(path, "..", "session-backup.jsonl"), "utf8")).toBe("original backup");
    }
  });

  test("reload and shutdown never silently restore opt-in authority", async () => {
    const f = fixture(); await f.request();
    await f.emit("session_start");
    expect(f.auto.status()).toBe("off");
    expect(f.notices.at(-1)).toContain("off after session reload");
    await f.auto.command("on", f.ctx as never);
    await f.emit("session_shutdown");
    expect(f.auto.status()).toBe("off");
  });

  test("rearms after fresh usage falls below 40", async () => {
    const f = fixture(); const { path, nonce } = await f.request(); await f.ready(path, nonce);
    f.setPercent(45); await f.emit("turn_end");
    expect(f.auto.status()).toBe("cooldown");
    f.setPercent(39); await f.emit("turn_end");
    expect(f.auto.status()).toBe("armed");
    f.setPercent(50); const result = await f.emit("turn_end");
    expect(result?.continue).toBe(true);
    cleanup.push(join(result.entries.at(-1).content.match(/Checkpoint file: (.+)/)[1], ".."));
  });

  test("zero-usage reload cannot inherit a rewritten pre-shake usage anchor", async () => {
    const f = fixture(); const { path, nonce } = await f.request(); await f.ready(path, nonce);
    const latest = f.entries.at(-1).message;
    latest.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
    f.setPercent(30); await f.emit("turn_end");
    expect(f.auto.status()).toBe("blocked");
  });

  test("an aborted checkpoint, dispatch, or reload invalidates recovery", async () => {
    for (const phase of ["checkpoint", "dispatch", "reload"]) {
      const f = fixture(); const { path, nonce } = await f.request();
      let dispatch: string | undefined;
      if (phase === "dispatch") {
        f.checkpoint(path, nonce); f.answer("SHAKE_READY " + nonce);
        await f.emit("agent_before_settle"); dispatch = f.sent[0]?.text;
      } else if (phase === "reload") await f.ready(path, nonce);
      await f.emit("agent_settled", { aborted: true });
      expect(f.auto.status()).toBe("blocked");
      if (dispatch) await f.auto.command(dispatch.replace("/shake auto ", ""), f.ctx as never);
      expect(f.rebuilds()).toBe(phase === "reload" ? 1 : 0);
      expect(readFileSync(join(path, "..", "handoff.md"), "utf8")).toContain("aborted");
    }
  });

  test("reload rejects codemode's non-tool capabilities and carries a Git snapshot", async () => {
    const f = fixture(); const { path, nonce } = await f.request(); await f.ready(path, nonce);
    expect((await f.emit("tool_call", { toolName: "codemode" })).block).toBe(true);
    expect(f.sent.at(-1)?.text).toContain("Git snapshot");
    expect(f.sent.at(-1)?.text).toContain("abc123");
  });

  test("Git inspection errors stop before rebuilding", async () => {
    const f = fixture(); const { path, nonce } = await f.request();
    f.setGitFailed(); await f.ready(path, nonce);
    expect(f.rebuilds()).toBe(0);
    expect(f.auto.status()).toBe("blocked");
  });

  test("cannot resume when queued work or the checkpoint changes during Git inspection", async () => {
    for (const change of ["queue", "checkpoint"]) {
      const f = fixture(); const { path, nonce } = await f.request(); await f.ready(path, nonce);
      f.setPercent(30);
      f.duringGit(() => {
        if (change === "queue") f.setPending(true);
        else f.checkpoint(path, nonce, { nextAction: "replaced during verification" });
      });
      await f.emit("turn_end");
      expect(f.auto.status()).toBe("blocked");
    }
  });

  test("abort during Git verification cannot release a continuation", async () => {
    const f = fixture(); const { path, nonce } = await f.request(); await f.ready(path, nonce);
    f.setPercent(30); f.duringGit(() => f.abortSignal());
    expect(await f.emit("turn_end")).toBeUndefined();
    expect(f.auto.status()).toBe("blocked");
    expect(readFileSync(join(path, "..", "handoff.md"), "utf8")).toContain("aborted");
  });

  test("bounds a checkpoint that never reaches readiness", async () => {
    const f = fixture(); await f.request();
    for (let i = 0; i < 24; i++) await f.emit("turn_end");
    expect(f.auto.status()).toBe("blocked");
    expect(f.aborted()).toBe(1);
    expect(f.rebuilds()).toBe(0);
  });

  test("off cancels a pending recovery and unknown usage never triggers", async () => {
    const f = fixture(); const { nonce } = await f.request();
    await f.auto.command("off", f.ctx as never);
    f.answer("SHAKE_READY " + nonce); await f.emit("agent_before_settle");
    expect(f.rebuilds()).toBe(0); expect(f.sent).toHaveLength(0);
    await f.auto.command("on", f.ctx as never);
    f.setPercent(null); expect(await f.emit("turn_end")).toBeUndefined();
    expect(f.auto.status()).toBe("armed");
  });
});
