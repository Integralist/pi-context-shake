/**
 * Engine and caller tests for pi-shake. Run: bun --no-env-file test.ts
 * Set CURRENT_SDK_ROOT to a pi-coding-agent package directory to test that host.
 */
import shakeExtension, { shakeMessages, canDropSignedThinking, rebuildEntries, estimateMessageTokens, shouldSkipAutoCompaction } from "./index.ts";
import type { ShakeMessage, ShakeModes, ShakeOptions, EntryLike } from "./index.ts";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const opts: ShakeOptions = { toolThreshold: 2000, blockThreshold: 12000, toolHead: 200, blockHead: 500 };
let failures = 0;
let checks = 0;

function check(name: string, cond: boolean, detail?: string) {
  checks++;
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const big = (n: number): string => "x".repeat(n);
const b64 = (n: number): string => Buffer.from(big(n)).toString("base64");

// --- Scenario 1: tool result elision + protection boundary ---------------
{
  const msgs: ShakeMessage[] = [
    { role: "user", content: "look at the log" },
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "c1", name: "bash", arguments: { command: "cat big.log" } },
      ],
    },
    { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: big(40_000) }], isError: false },
    { role: "user", content: "and this new image" },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "c2", name: "read", arguments: { path: "a.ts" } }],
    },
    { role: "toolResult", toolCallId: "c2", toolName: "read", content: [{ type: "text", text: big(60_000) }], isError: false },
  ];

  const all: ShakeModes = { tools: true, images: true, thinking: true };
  const { messages, stats } = shakeMessages(msgs, all, opts, true);

  const old = messages[2]!;
  check("old big tool result elided", typeof old.content === "object" && old.content!.length > 0 &&
    (old.content![0] as { text: string }).text.startsWith("[shaken: ~"), "got: " + JSON.stringify(old.content![0]));
  check("elided tool result keeps head preview", (old.content![0] as { text: string }).text.includes("(head) xxx"));
  check("tool stats counted", stats.toolCount === 1 && stats.toolChars > 30_000, `count=${stats.toolCount} chars=${stats.toolChars}`);

  const fresh = msgs[4]!;
  check("in-flight tool result protected", JSON.stringify(fresh.content) === JSON.stringify(msgs[4]!.content));
  const curUser = msgs[3]!;
  check("current user message protected", JSON.stringify(curUser) === JSON.stringify(msgs[3]!));
}

// --- Scenario 2: idle context — last user message is old, gets shaken -----
{
  const longPaste = big(20_000);
  const msgs: ShakeMessage[] = [
    { role: "user", content: longPaste },
    { role: "assistant", content: [{ type: "text", text: "done, here is the summary" }] },
  ];
  const { messages } = shakeMessages(msgs, { tools: true, images: false, thinking: false }, opts, true);
  const shaken = messages[0]!;
  check("old long user paste trimmed", typeof shaken.content === "string" &&
    shaken.content.includes("[shaken:") && (shaken.content as string).length < 2000,
    `len=${(shaken.content as string).length}`);
  check("final assistant reply untouched", messages[1]!.content === msgs[1]!.content);
}

// --- Scenario 3: images ---------------------------------------------------
{
  const msgs: ShakeMessage[] = [
    { role: "user", content: "describe" },
    { role: "assistant", content: [{ type: "text", text: "ok" }] },
    {
      role: "user",
      content: [
        { type: "text", text: "two shots:" },
        { type: "image", data: b64(100_000), mimeType: "image/png" },
        { type: "image", data: b64(50_000), mimeType: "image/jpeg" },
      ],
    },
    { role: "assistant", content: [{ type: "text", text: "final answer" }] },
  ];
  const { messages, stats } = shakeMessages(msgs, { tools: false, images: true, thinking: false }, opts, true);
  const shaken = messages[2]!;
  const texts = (shaken.content as { type: string; text?: string }[]).filter((b) => b.type === "text");
  const images = (shaken.content as { type: string }[]).filter((b) => b.type === "image");
  check("both images removed", images.length === 0);
  check("one placeholder for consecutive images", texts.some((t) => t.text!.startsWith("[shaken: image removed (image/png, ~98 KB)")),
    JSON.stringify(texts));
  check("image stats counted", stats.imageCount === 2 && stats.imageBytes > 150_000);
}

// --- Scenario 4: thinking, signed vs unsigned -----------------------------
{
  const msgs: ShakeMessage[] = [
    { role: "user", content: "think hard" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: big(5_000), thinkingSignature: "sig-abc" },
        { type: "thinking", thinking: big(3_000) },
        { type: "redactedThinking", data: "opaque" },
        { type: "text", text: "answer" },
      ],
    },
    { role: "user", content: "next" },
    { role: "assistant", content: [{ type: "text", text: "final" }] },
  ];

  const safe = shakeMessages(msgs, { tools: false, images: false, thinking: true }, opts, true);
  const safeBlocks = safe.messages[1]!.content as unknown as { type: string; text?: string; thinkingSignature?: string }[];
  check("unsigned thinking dropped", !safeBlocks.some((b) => b.type === "thinking"));
  check("redacted dropped when allowed", !safeBlocks.some((b) => b.type === "redactedThinking"));
  check("text kept", safeBlocks.some((b) => b.type === "text" && b.text === "answer"));
  check("thinking stats", safe.stats.thinkingCount === 3 && safe.stats.thinkingChars >= 8_000);

  const unsafe = shakeMessages(msgs, { tools: false, images: false, thinking: true }, opts, false);
  const unsafeBlocks = (unsafe.messages[1]!.content as { type: string; thinkingSignature?: string }[]);
  check("signed thinking kept when unsafe", unsafeBlocks.some((b) => b.type === "thinking" && b.thinkingSignature === "sig-abc"));
  check("redacted kept when unsafe", unsafeBlocks.some((b) => b.type === "redactedThinking"));
  check("unsigned still dropped when unsafe", !unsafeBlocks.some((b) => b.type === "thinking" && !b.thinkingSignature));
}

// --- Scenario 5: thinking-only assistant message doesn't become empty -----
{
  const msgs: ShakeMessage[] = [
    { role: "user", content: "think" },
    { role: "assistant", content: [{ type: "thinking", thinking: big(1_000) }] },
    { role: "user", content: "go" },
    { role: "assistant", content: [{ type: "text", text: "x" }] },
  ];
  const { messages } = shakeMessages(msgs, { tools: false, images: false, thinking: true }, opts, true);
  const content = messages[1]!.content as { type: string; text?: string }[];
  check("placeholder text inserted for emptied message", content.length === 1 && content[0]!.type === "text" &&
    content[0]!.text!.includes("thinking elided"));
}

// --- Scenario 6: bashExecution output elision ------------------------------
{
  const msgs: ShakeMessage[] = [
    { role: "user", content: "run it" },
    { role: "bashExecution", command: "make", output: big(30_000), exitCode: 0, cancelled: false, truncated: false },
    { role: "user", content: "now what?" },
    { role: "assistant", content: [{ type: "text", text: "built" }] },
  ];
  const { messages, stats } = shakeMessages(msgs, { tools: true, images: false, thinking: false }, opts, true);
  const bash = messages[1]!;
  check("bash output elided", typeof bash.output === "string" && bash.output.includes("[shaken:") && bash.output.length < 1500,
    `len=${bash.output?.length}`);
  check("bash stats", stats.bashChars > 25_000);
}

// --- Scenario 7: idempotency ------------------------------------------------
{
  const msgs: ShakeMessage[] = [
    { role: "user", content: "start" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: big(4_000) },
        { type: "toolCall", id: "c1", name: "bash", arguments: {} },
      ],
    },
    { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: big(50_000) }], isError: false },
    { role: "user", content: "again" },
    { role: "assistant", content: [{ type: "text", text: "final" }] },
  ];
  const all: ShakeModes = { tools: true, images: true, thinking: true };
  const pass1 = shakeMessages(msgs, all, opts, true);
  const pass2 = shakeMessages(pass1.messages, all, opts, true);
  const noChange = pass2.messages.every((m, i) => JSON.stringify(m) === JSON.stringify(pass1.messages[i]));
  const secondFreed =
    pass2.stats.toolChars + pass2.stats.bashChars + pass2.stats.blockChars + pass2.stats.imageBytes + pass2.stats.thinkingChars;
  check("second pass is a no-op", noChange && secondFreed === 0, `freed=${secondFreed}`);
}

// --- Scenario 8: everything off → untouched ---------------------------------
{
  const msgs: ShakeMessage[] = [
    { role: "user", content: big(50_000) },
    { role: "assistant", content: [{ type: "thinking", thinking: big(50_000) }, { type: "text", text: "hi" }] },
  ];
  const off: ShakeModes = { tools: false, images: false, thinking: false };
  const { messages, stats } = shakeMessages(msgs, off, opts, true);
  const identical = messages.every((m, i) => m === msgs[i]);
  const freed = stats.toolChars + stats.bashChars + stats.blockChars + stats.imageBytes + stats.thinkingChars;
  check("off policy leaves messages identical", identical && freed === 0);
}

// --- Scenario 9: canDropSignedThinking --------------------------------------
{
  check("non-anthropic allowed", canDropSignedThinking({ api: "openai-completions" }) === true);
  check("anthropic without beta kept", canDropSignedThinking({ api: "anthropic-messages" }) === false);
  check("anthropic with beta allowed", canDropSignedThinking({ api: "anthropic-messages", compat: { supportsMidConvoEffort: true } }) === true);
  check("unknown model preserves signed thinking", canDropSignedThinking(undefined) === false);
}

// --- Scenario 10: compaction/branch summary roles pass through -------------
{
  const msgs: ShakeMessage[] = [
    { role: "compactionSummary", content: "old summary" },
    { role: "branchSummary", content: "branch summary text" },
    { role: "user", content: "hi" },
    { role: "assistant", content: [{ type: "text", text: "yo" }] },
  ];
  const { messages, stats } = shakeMessages(msgs, { tools: true, images: true, thinking: true }, opts, true);
  const identical = messages.every((m, i) => m === msgs[i]);
  check("summary roles untouched", identical && stats.thinkingCount === 0);
}


// --- Scenario 11: rebuildEntries (session file rebuild) ---------------------
{
  const header: EntryLike = { type: "session", version: 3, id: "abc", created_at: 1, updated_at: 2, cwd: "/tmp" };
  const e1: EntryLike = { type: "message", id: "1", parentId: null, timestamp: 3, message: { role: "user", content: big(20_000) } };
  const e2: EntryLike = {
    type: "message",
    id: "2",
    parentId: "1",
    timestamp: 4,
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: big(5_000), thinkingSignature: "sig" },
        { type: "toolCall", id: "c1", name: "bash", arguments: {} },
      ],
    },
  };
  const e3: EntryLike = {
    type: "message",
    id: "3",
    parentId: "2",
    timestamp: 5,
    message: { role: "toolResult", toolCallId: "c1", toolName: "bash", isError: false, content: [{ type: "text", text: big(40_000) }] },
  };
  const e4: EntryLike = {
    type: "message",
    id: "4",
    parentId: "3",
    timestamp: 6,
    message: {
      role: "user",
      content: [
        { type: "text", text: "see:" },
        { type: "image", data: b64(100_000), mimeType: "image/png" },
      ],
    },
  };
  const e5: EntryLike = {
    type: "message",
    id: "5",
    parentId: "4",
    timestamp: 7,
    message: { role: "bashExecution", command: "make", output: big(30_000), exitCode: 0, cancelled: false, truncated: false },
  };
  const e6: EntryLike = { type: "custom_message", id: "6", parentId: "5", timestamp: 8, content: big(20_000) };
  const e7: EntryLike = { type: "label", id: "7", parentId: "6", timestamp: 9, marker: "m", label: "keep" };
  const e8: EntryLike = {
    type: "message",
    id: "8",
    parentId: "7",
    timestamp: 10,
    message: { role: "assistant", content: [{ type: "thinking", thinking: big(4_000) }, { type: "text", text: "final" }] },
  };
  const entries: EntryLike[] = [header, e1, e2, e3, e4, e5, e6, e7, e8];
  const all: ShakeModes = { tools: true, images: true, thinking: true };

  const { entries: rebuilt, stats } = rebuildEntries(entries, opts, all, true);
  const r1 = rebuilt[1] as unknown as { message: { content: string } };
  const r2 = rebuilt[2] as unknown as { message: { content: { type: string; thinkingSignature?: string }[] } };
  const r3 = rebuilt[3] as unknown as { message: { content: { type: string; text?: string }[] } };
  const r4 = rebuilt[4] as unknown as { message: { content: { type: string; text?: string }[] } };
  const r5 = rebuilt[5] as unknown as { message: { output: string } };
  const r6 = rebuilt[6] as unknown as { content: string };

  check("long user string elided", typeof r1.message.content === "string" && r1.message.content.includes("[shaken:") && r1.message.content.length < 2000);
  check("assistant thinking dropped, toolCall kept", r2.message.content.every((b) => b.type !== "thinking") && r2.message.content.some((b) => b.type === "toolCall"));
  check("tool result elided", r3.message.content.length === 1 && r3.message.content[0]!.text!.startsWith("[shaken: ~") && r3.message.content[0]!.text!.includes('"bash"'));
  check(
    "image replaced with placeholder",
    r4.message.content.every((b) => b.type !== "image") &&
      r4.message.content.some((b) => b.type === "text" && b.text!.startsWith("[shaken: image removed (image/png, ~98 KB)")),
  );
  check("bash output elided", r5.message.output.includes("[shaken:") && r5.message.output.length < 1500);
  check("custom_message long string elided", typeof r6.content === "string" && r6.content.length < 2000 && r6.content.includes("[shaken:"));
  check("header/label entries untouched", rebuilt[0] === header && rebuilt[7] === e7);
  check("rebuild counted everything", stats.thinkingCount === 2 && stats.toolCount >= 2 && stats.imageCount === 1 && stats.blockCount >= 2);

  const pass2 = rebuildEntries(rebuilt, opts, all, true);
  const freed2 = pass2.stats.toolChars + pass2.stats.bashChars + pass2.stats.blockChars + pass2.stats.imageBytes + pass2.stats.thinkingChars;
  check("second rebuild is a no-op", pass2.entries.every((e, i) => e === rebuilt[i]) && freed2 === 0);

  const keptSigned = rebuildEntries(entries, opts, { tools: false, images: false, thinking: true }, false);
  const k2 = keptSigned.entries[2] as unknown as { message: { content: { type: string; thinkingSignature?: string }[] } };
  const k8 = keptSigned.entries[8] as unknown as { message: { content: { type: string }[] } };
  check("signed thinking kept when unsafe", k2.message.content.some((b) => b.type === "thinking" && b.thinkingSignature === "sig"));
  check("unsigned thinking dropped even when unsafe", k8.message.content.every((b) => b.type !== "thinking"));

  const off = rebuildEntries(entries, opts, { tools: false, images: false, thinking: false }, true);
  check("off modes leave entries identical", off.entries.every((e, i) => e === entries[i]));
}

// --- Scenario 12: estimateMessageTokens -----------------------------------
{
  const msgs: ShakeMessage[] = [
    { role: "user", content: "x".repeat(4000) },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "t".repeat(4000) },
        { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
      ],
    },
    { role: "toolResult", toolCallId: "c1", toolName: "bash", isError: false, content: [{ type: "text", text: "y".repeat(8000) }] },
    { role: "bashExecution", command: "ls", output: "z".repeat(12000), exitCode: 0, cancelled: false, truncated: false },
    { role: "compactionSummary", content: "s".repeat(4000) },
  ];
  const est = estimateMessageTokens(msgs);
  const user = 4000 / 4;
  const assistant = Math.ceil((4000 + ("bash".length + JSON.stringify({ command: "ls" }).length)) / 4);
  const tool = 8000 / 4;
  const bash = Math.ceil(("ls".length + 12000) / 4);
  const compaction = 4000 / 4;
  check("per-message estimator sums correctly", est === user + assistant + tool + bash + compaction, `got=${est} want=${user + assistant + tool + bash + compaction}`);
}

// --- Scenario 13: shouldSkipAutoCompaction ----------------------------------
{
  const window = 200_000;
  const reserve = 10_000;
  const all: ShakeModes = { tools: true, images: true, thinking: true };

  // Big history that is shaken down well under the threshold.
  const bigHistory: ShakeMessage[] = [
    { role: "user", content: "look" },
    { role: "assistant", content: [{ type: "thinking", thinking: big(50_000) }] },
    { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: {} }] },
    { role: "toolResult", toolCallId: "c1", toolName: "bash", isError: false, content: [{ type: "text", text: big(80_000) }] },
    { role: "user", content: "go" },
    { role: "assistant", content: [{ type: "text", text: "done" }] },
  ];
  check("skip compaction when shaken fits", shouldSkipAutoCompaction({ modes: all, messages: bigHistory, opts, contextWindow: window, reserveTokens: reserve, model: undefined }) === true);

  // Still too big: the latest user message (and its pending turn) is a giant
  // paste — boundary-protected, so shaking cannot reduce it.
  const stillBig: ShakeMessage[] = [
    { role: "user", content: "hi" },
    { role: "assistant", content: [{ type: "text", text: "ok" }] },
    { role: "user", content: big(1_000_000) },
    { role: "assistant", content: [{ type: "text", text: "working" }, { type: "toolCall", id: "c9", name: "bash", arguments: {} }] },
  ];
  check("do not skip when boundary-protected content is over threshold", shouldSkipAutoCompaction({ modes: all, messages: stillBig, opts, contextWindow: window, reserveTokens: reserve, model: undefined }) === false);

  check("never skip when modes off", shouldSkipAutoCompaction({ modes: { tools: false, images: false, thinking: false }, messages: bigHistory, opts, contextWindow: window, reserveTokens: reserve, model: undefined }) === false);
  check("never skip with no context window", shouldSkipAutoCompaction({ modes: all, messages: bigHistory, opts, contextWindow: 0, reserveTokens: reserve, model: undefined }) === false);
}
// --- Scenario 14: status widget can be hidden ------------------------------
{
  type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
  const handlers = new Map<string, Handler[]>();
  let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  const fakePi = {
    on: (name: string, h: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), h]),
    registerCommand: (_name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
      command = def.handler;
    },
  };
  shakeExtension(fakePi as never);

  const widgets = new Map<string, string[] | undefined>();
  const ctx = {
    hasUI: true,
    model: undefined,
    ui: {
      setWidget: (key: string, lines: string[] | undefined) => widgets.set(key, lines),
      notify: () => {},
    },
    sessionManager: { getEntries: () => [] },
    getContextUsage: () => undefined,
  };
  const emit = async (name: string, event: unknown) => {
    for (const h of handlers.get(name) ?? []) await h(event, ctx);
  };

  await command?.("", ctx);
  check("/shake shows the status widget", Array.isArray(widgets.get("pi-shake")));

  await command?.("hide", ctx);
  check("/shake hide clears the status widget", widgets.get("pi-shake") === undefined);

  await command?.("", ctx);
  await emit("input", { type: "input", text: "next prompt", source: "interactive" });
  check("next prompt auto-hides the status widget", widgets.get("pi-shake") === undefined);
}

// --- Scenario 15: registered callers preserve uncertain replay data (AC037) ---
{
  type Handler = (event: any, ctx: any) => Promise<any>;
  const cases = [
    { name: "missing model", model: undefined, drop: false },
    { name: "missing API", model: {}, drop: false },
    { name: "empty API", model: { api: "" }, drop: false },
    { name: "virtual", model: { api: "pi-virtual", compat: { supportsMidConvoEffort: true } }, drop: false },
    { name: "physical Anthropic", model: { api: "anthropic-messages" }, drop: false },
    { name: "physical beta", model: { api: "anthropic-messages", compat: { supportsMidConvoEffort: true } }, drop: true },
    { name: "physical non-Anthropic", model: { api: "openai-completions" }, drop: true },
  ];
  for (const test of cases) {
    const handlers = new Map<string, Handler>();
    let command: any;
    shakeExtension({ on: (name: string, handler: Handler) => handlers.set(name, handler),
      registerCommand: (_name: string, definition: any) => { command = definition.handler; } } as never);
    const signed = { type: "thinking", thinking: big(5_000), thinkingSignature: "opaque:do-not-parse" };
    const redacted = { type: "thinking", thinking: "", thinkingSignature: "encrypted", redacted: true };
    const legacy = { type: "redactedThinking", data: "opaque-legacy" };
    const history: ShakeMessage[] = [
      { role: "user", content: big(20_000) },
      { role: "assistant", content: [signed, redacted, legacy, { type: "thinking", thinking: big(3_000) }, { type: "text", text: "answer" }] },
      { role: "toolResult", toolName: "bash", content: [{ type: "text", text: big(40_000) }] },
      { role: "user", content: [{ type: "image", data: b64(1_000), mimeType: "image/png" }] },
      { role: "user", content: "active prompt" },
    ];
    const original = JSON.stringify(history);
    const entries = history.map((message) => ({ type: "message", message }));
    let widget: string[] = [];
    const notices: string[] = [];
    const ctx = {
      model: test.model ? { ...test.model, contextWindow: 200000 } : undefined, hasUI: true, isIdle: () => true,
      ui: { setWidget: (_key: string, lines?: string[]) => { widget = lines ?? []; }, notify: (text: string) => notices.push(text) },
      sessionManager: { getEntries: () => [...entries, { type: "custom", customType: "pi-shake", data: { modes: { tools: true, images: true, thinking: true } } }], getSessionFile: () => undefined, buildContextEntries: () => entries },
      getContextUsage: () => undefined,
    };
    await handlers.get("session_start")!({}, ctx);
    const result = await handlers.get("context")!({ messages: history }, ctx);
    const blocks = result?.messages[1].content as any[];
    check(`${test.name}: registered context preserves opaque blocks iff required`,
      !!blocks && [signed, redacted, legacy].every((block) => blocks.some((kept) => JSON.stringify(kept) === JSON.stringify(block)) === !test.drop));
    check(`${test.name}: unsigned, tools, images and long text still shake`, !!result &&
      !blocks.some((block) => block.type === "thinking" && !block.thinkingSignature) &&
      result.messages[0].content.includes("[shaken:") && result.messages[2].content[0].text.includes("[shaken:") &&
      result.messages[3].content[0].type === "text" && result.messages[4] === history[4]);
    check(`${test.name}: input history not mutated`, JSON.stringify(history) === original);
    await command("", ctx);
    check(`${test.name}: status estimate excludes retained signatures`, widget.some((line) => line.includes(test.drop ? "~2,000 tokens thinking (4)" : "~750 tokens thinking (1)")));
    check(`${test.name}: status discloses preservation iff required`, widget.some((line) => line.includes("signed thinking kept")) === !test.drop);
    await command("all", ctx);
    check(`${test.name}: ephemeral rebuild refuses without changing context`, notices.some((line) => line.includes("ephemeral")) && JSON.stringify(history) === original);
    const threshold = { reason: "threshold", preparation: { settings: { enabled: true, reserveTokens: 16384 } } };
    const compact = await handlers.get("session_before_compact")!(threshold, ctx);
    check(`${test.name}: compaction without usage requires a physical selection`, (compact?.cancel === true) === (!!test.model?.api && test.model.api !== "pi-virtual"));
    if (ctx.model) ctx.model.contextWindow = 0;
    check(`${test.name}: zero or missing window never cancels`, !(await handlers.get("session_before_compact")!(threshold, ctx))?.cancel);
  }
}

// --- Scenario 16: offline public SDK host matrix (AC032/AC033/AC037) ---------
// Dynamic package-root imports let the old development SDK stay pinned. The
// plugin itself has no runtime SDK import and no dependency on a router.
{
  const sdkRoot = process.env.CURRENT_SDK_ROOT ?? dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
  const sdk = await import(pathToFileURL(join(sdkRoot, "dist/index.js")).href);
  const ai = await import(pathToFileURL(join(dirname(sdkRoot), "pi-ai/dist/index.js")).href);
  const version = JSON.parse(readFileSync(join(sdkRoot, "package.json"), "utf8")).version;
  console.log(`\nSDK host: ${version} (${sdkRoot})`);
  const all = { tools: true, images: true, thinking: true };
  const unsigned = { type: "thinking", thinking: big(3_000) };
  const signed = { type: "thinking", thinking: big(5_000), thinkingSignature: "opaque-signed" };
  const redacted = { type: "thinking", thinking: "", thinkingSignature: "opaque-redacted", redacted: true };

  async function fixture(options: { api?: string; beta?: boolean; native?: boolean; evidence?: string; seed?: (manager: any) => void; disk?: boolean } = {}) {
    const directory = mkdtempSync(join(tmpdir(), "pi-shake-test-"));
    const fake = ai.fauxProvider({ provider: "shake-offline", api: options.api ?? "anthropic-messages",
      models: [{ id: "small", reasoning: true, contextWindow: 32768 }, { id: "large", reasoning: true, contextWindow: 200000 }], tokensPerSecond: 1_000_000 });
    for (const model of fake.models) {
      model.thinkingLevelMap = { high: "high", xhigh: "xhigh" };
      if (options.beta) model.compat = { ...model.compat, supportsMidConvoEffort: true };
    }
    const runtime = await sdk.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsStore: new ai.InMemoryModelsStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
    for (const provider of runtime.getProviders()) runtime.registerNativeProvider({ ...provider,
      auth: { apiKey: { name: "Offline fixture", resolve: async () => undefined } }, filterModels: () => [] });
    runtime.registerNativeProvider(fake.provider);
    let routeId = "small";
    let routeError = false;
    const routes: any[] = [];
    if (options.native) runtime.registerVirtualModel({ provider: "synthetic-shake-router", id: "choice", name: "Synthetic choice",
      contextWindow: 200000, thinkingLevels: ["high", "xhigh"],
      route(request: any) {
        routes.push({ reason: request.reason, previous: request.previous?.model.id, selected: request.thinkingLevel });
        if (routeError) throw new Error("synthetic route failure");
        return { model: runtime.getModel("shake-offline", routeId), thinkingLevel: "high", state: { opaque: ["not", "a", "physical", "contract"] } };
      } });
    let manager = sdk.SessionManager.inMemory(directory);
    if (options.seed) options.seed(manager);
    else {
      manager.appendMessage({ role: "user", content: "old prompt", timestamp: 1 });
      const source = { ...ai.fauxAssistantMessage([signed, unsigned, redacted, { type: "text", text: "old answer" }]),
        provider: options.evidence === "unknown" ? "not-in-catalog" : "shake-offline", api: fake.api, model: "small", thinkingLevel: "high" };
      if (options.evidence === "failed") {
        manager.appendMessage({ ...source, stopReason: "error", errorMessage: "synthetic previous error" });
        manager.appendMessage({ ...source, stopReason: "aborted" });
      } else manager.appendMessage(source);
    }
    manager.appendCustomEntry("pi-shake", { modes: all });
    if (options.disk) {
      const file = join(directory, "session.jsonl");
      writeFileSync(file, [manager.getHeader(), ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
      manager = sdk.SessionManager.open(file);
    }
    const settings = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
    const loader = new sdk.DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [shakeExtension] });
    await loader.reload();
    const { session, extensionsResult } = await sdk.createAgentSession({ cwd: directory, agentDir: directory, modelRuntime: runtime, settingsManager: settings,
      sessionManager: manager, resourceLoader: loader, tools: [], model: runtime.getModel(options.native ? "synthetic-shake-router" : "shake-offline", options.native ? "choice" : "small"), thinkingLevel: "xhigh" });
    const notices: string[] = [];
    const status: string[] = [];
    const errors: string[] = [];
    await session.bindExtensions({ mode: "print", uiContext: { notify: (text: string) => notices.push(text), setWidget: (_key: string, lines?: string[]) => { status.splice(0, status.length, ...(lines ?? [])); } }, onError: (error: any) => errors.push(error.error) });
    await runtime.refresh({ allowNetwork: false });
    check(`${version}: SDK extension load is clean`, extensionsResult.errors.length === 0 && errors.length === 0);
    const compact = (reason = "threshold", enabled = true) => session.extensionRunner.emit({ type: "session_before_compact", reason,
      preparation: { settings: { enabled, reserveTokens: 16384 } }, branchEntries: manager.getBranch(), signal: new AbortController().signal });
    return { session, manager, runtime, fake, notices, status, errors, routes, compact,
      route(id: string) { routeId = id; }, failRoute() { routeError = true; },
      close() { session.dispose(); rmSync(directory, { recursive: true, force: true }); } };
  }

  for (const test of [{ api: "anthropic-messages", drop: false }, { api: "anthropic-messages", beta: true, drop: true }, { api: "openai-completions", drop: true }]) {
    const f = await fixture(test);
    const name = `${version}: physical ${test.api}${test.beta ? " beta" : ""}`;
    try {
      const calls: any[] = [];
      f.fake.setResponses([(context: any, options: any) => { calls.push({ context, effort: options?.reasoning }); return ai.fauxAssistantMessage("offline response"); }]);
      await f.session.prompt("next prompt");
      const replay = calls[0]?.context.messages.find((message: any) => message.role === "assistant");
      check(`${name}: actual dispatch obeys signature policy`, !!replay && replay.content.some((block: any) => block.thinkingSignature === "opaque-signed") === !test.drop);
      check(`${name}: actual dispatch removes unsigned thinking`, !!replay && !replay.content.some((block: any) => block.type === "thinking" && !block.thinkingSignature));
      check(`${name}: selected physical xhigh is authoritative`, f.session.thinkingLevel === "xhigh" && calls[0]?.effort === "xhigh");
      check(`${name}: fitting threshold cancellation retained`, (await f.compact())?.cancel === true);
      check(`${name}: manual, overflow, disabled are not cancelled`, !(await f.compact("manual"))?.cancel && !(await f.compact("overflow"))?.cancel && !(await f.compact("threshold", false))?.cancel);
      f.manager.appendCustomEntry("pi-shake", { modes: { tools: false, images: false, thinking: false } });
      await f.session.extensionRunner.emit({ type: "session_start" });
      check(`${name}: modes off is not cancelled`, !(await f.compact())?.cancel);
      check(`${name}: no extension errors and one faux call`, f.errors.length === 0 && f.fake.state.callCount === 1);
    } finally { f.close(); }
  }

  // Exercise the real command's disk caller only on disposable fixture files.
  const disk = await fixture({ native: typeof sdk.ModelRuntime.prototype.registerVirtualModel === "function", disk: true });
  try {
    await disk.session.prompt("/shake thinking");
    const records = readFileSync(disk.manager.getSessionFile(), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const replay = records.find((entry) => entry.type === "message" && entry.message.role === "assistant").message;
    check(`${version}: disk command preserves signed and redacted data`, replay.content.some((block: any) => block.thinkingSignature === "opaque-signed") && replay.content.some((block: any) => block.redacted));
    check(`${version}: disk command removes unsigned data only`, !replay.content.some((block: any) => block.type === "thinking" && !block.thinkingSignature) && disk.notices.some((line) => line.includes("~750 tokens freed")));
    check(`${version}: disk command re-reads the real manager without dispatch`, disk.fake.state.callCount === 0 && disk.manager.getEntries().some((entry: any) => entry.type === "custom" && entry.customType === "pi-shake") && disk.errors.length === 0);
  } finally { disk.close(); }

  if (typeof sdk.ModelRuntime.prototype.registerVirtualModel === "function") {
    for (const evidence of ["known", "unknown", "failed"]) {
      const f = await fixture({ native: true, evidence });
      const name = `${version}: native ${evidence}`;
      try {
        await f.session.prompt("/shake");
        check(`${name}: status counts unsigned only and explains preservation`, f.status.some((line) => line.includes("signed thinking kept")) && f.status.some((line) => line.includes(evidence === "failed" ? "~1,500 tokens thinking (2)" : "~750 tokens thinking (1)")));
        await f.session.prompt("/shake all");
        check(`${name}: ephemeral command refuses without routing`, f.notices.some((line) => line.includes("ephemeral")) && f.routes.length === 0 && f.fake.state.callCount === 0);
        check(`${name}: threshold delegates despite positive virtual/usage limit`, !(await f.compact())?.cancel);
        const payloads: any[] = [];
        f.fake.setResponses(["large", "small"].map(() => (context: any, options: any, _state: any, model: any) => {
          payloads.push({ context, effort: options?.reasoning, model: model.id }); return ai.fauxAssistantMessage("offline routed response");
        }));
        f.route("large");
        await f.session.prompt("first routed prompt");
        f.route("small");
        check(`${name}: previous large route never authorizes next cancellation`, !(await f.compact())?.cancel);
        await f.session.prompt("second routed prompt");
        const firstReplay = payloads[0]?.context.messages.find((message: any) => message.role === "assistant");
        // Failed/aborted responses are not replayed by Pi, so use the context
        // caller suite above for their opaque blocks, not a faux acceptance claim.
        if (evidence !== "failed") check(`${name}: faux payload retains signed/redacted and removes unsigned`, !!firstReplay && firstReplay.content.some((block: any) => block.thinkingSignature === "opaque-signed") && firstReplay.content.some((block: any) => block.redacted) && !firstReplay.content.some((block: any) => block.type === "thinking" && !block.thinkingSignature));
        check(`${name}: selected pair unchanged and physical effort not reused from virtual`, f.session.model.api === "pi-virtual" && f.session.thinkingLevel === "xhigh" && payloads.length === 2 && payloads.every((payload) => payload.effort === "high") && payloads[0].model === "large" && payloads[1].model === "small", JSON.stringify({ selected: f.session.model, effort: f.session.thinkingLevel, calls: payloads.map(({ effort, model }) => ({ effort, model })) }));
        const completed = f.session.messages.filter((message: any) => message.role === "assistant" && message.content.some((block: any) => block.text === "offline routed response"));
        check(`${name}: completed messages carry physical metadata and zero faux cost`, completed.length === 2 && completed.every((message: any) => message.provider === "shake-offline" && message.api === "anthropic-messages" && message.thinkingLevel === "high" && message.usage.cost.total === 0), JSON.stringify(completed));
        check(`${name}: failed-only or unknown catalog is not prior physical evidence`, evidence === "known" ? f.routes[0]?.previous === "small" : f.routes[0]?.previous === undefined);
        f.failRoute();
        await f.session.prompt("route must fail safely");
        const last = f.session.messages.at(-1);
        check(`${name}: public routing error remains an error without provider fallback`, last?.role === "assistant" && last.stopReason === "error" && last.errorMessage.includes("synthetic route failure") && f.fake.state.callCount === 2, JSON.stringify({ last, calls: f.fake.state.callCount }));
        check(`${name}: error does not authorize compaction or change selection`, !(await f.compact())?.cancel && f.session.model.api === "pi-virtual" && f.session.thinkingLevel === "xhigh" && f.errors.length === 0, JSON.stringify({ errors: f.errors, model: f.session.model, effort: f.session.thinkingLevel }));
      } finally { f.close(); }
    }
  } else {
    check(`${version}: old host absence of native/projection APIs is explicit`, typeof sdk.SessionManager.prototype.buildSessionProjection === "undefined");
    if (process.env.CURRENT_SDK_ROOT) check("requested current host must expose native registration", false);
    console.log("  SKIP native routing and canonical projection: unavailable on this old physical host");
  }

  if (typeof sdk.SessionManager.prototype.buildSessionProjection === "function") {
    const user = (content: string) => ({ role: "user", content, timestamp: 1 });
    const seeds: { name: string; seed: (manager: any) => void; cancel: boolean }[] = [
      { name: "larger replacement protects the active user", cancel: false, seed(manager) { const id = manager.appendMessage(user("short")); manager.appendContextEdit(id, { content: big(100_000) }); } },
      { name: "omitted user contributes no tokens", cancel: true, seed(manager) { const id = manager.appendMessage(user(big(100_000))); manager.appendContextEdit(id, null); } },
      { name: "checkpoint sections are counted", cancel: false, seed(manager) { manager.appendMessage({ role: "system", content: "", sections: { instructions: big(100_000) }, timestamp: 1 }); manager.appendMessage(user("old")); manager.appendCompaction("summary", null, 50_000); manager.appendMessage(user("short")); } },
      { name: "checkpoint tools are counted", cancel: false, seed(manager) { manager.appendMessage({ role: "system", content: "", toolsAdded: [{ name: "large-schema", description: big(100_000), parameters: {} }], timestamp: 1 }); manager.appendMessage(user("old")); manager.appendCompaction("summary", null, 50_000); manager.appendMessage(user("short")); } },
      { name: "canonical summary text is counted", cancel: false, seed(manager) { manager.appendMessage(user("old")); manager.appendCompaction(big(100_000), null, 50_000); manager.appendMessage(user("short")); } },
      { name: "canonical branch summary is counted", cancel: false, seed(manager) { const id = manager.appendMessage(user("old")); manager.branchWithSummary(id, big(100_000)); manager.appendMessage(user("short")); } },
      { name: "retained pre-compaction input is counted", cancel: false, seed(manager) { const id = manager.appendMessage(user(big(100_000))); manager.appendCompaction("summary", id, 50_000); } },
      { name: "summarized-away input is excluded", cancel: true, seed(manager) { manager.appendMessage(user(big(100_000))); manager.appendCompaction("summary", null, 50_000); manager.appendMessage(user("short")); } },
    ];
    for (const test of seeds) {
      const f = await fixture({ seed: test.seed });
      try { check(`${version}: projection ${test.name}`, ((await f.compact())?.cancel === true) === test.cancel); }
      finally { f.close(); }
    }
  }
}

console.log(JSON.stringify({ checks, passed: checks - failures, failures }));
console.log(failures === 0 ? "\nall tests passed" : `\n${failures} test(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
