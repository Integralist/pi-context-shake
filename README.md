# pi-context-shake

A [pi](https://pi.dev) extension that frees context space by shaking heavy content
(tool output, images, thinking) out of the session history — like omp's `/shake`,
but for vanilla pi. It **rebuilds the session in place**: the session's `.jsonl`
file is rewritten atomically and re-read by the running session manager, so the
persisted history and the transcript are the shaken version (and any later
`/resume` opens it). A `context` hook keeps the live LLM payload shaken.

## Commands

| Command           | Effect                                                                                    |
| ----------------- | ----------------------------------------------------------------------------------------- |
| `/shake`          | Status: shaken modes, context usage, what can be removed (auto-hides on your next prompt) |
| `/shake hide`     | Hide the status panel                                                                     |
| `/shake tools`    | Elide big tool results / bash output / long text blocks in history                        |
| `/shake images`   | Replace image blocks in history with one-line placeholders                                |
| `/shake thinking` | Drop thinking/reasoning blocks from history                                               |
| `/shake all`      | All of the above in one rebuild                                                           |

Thresholds (chars ≈ tokens/4): tool results / bash output > **2,000** chars become
a one-line placeholder with a 200-char head preview; text blocks > **12,000**
chars are trimmed to a 500-char head preview. Shaking a session again later
shakes the new turns too (idempotent on already-shaken content).

## How it works

1. The session file is read and its message entries are transformed: thinking
   dropped, tool results elided, images replaced, long text trimmed. Entry ids
   and the session tree are preserved.
2. The file is written atomically (temp + rename) with a single `pi-shake`
   state entry appended that records the enabled modes, then the running
   session manager re-reads the file — the persisted session becomes the
   shaken version (and so will any later `/resume`). No session switch: the
   running process keeps its in-memory state (the `context` hook in point 3
   keeps the live LLM payload shaken).
3. A `context` hook (active while the session is marked shaken) also rewrites
   the copy sent to the provider on every LLM call, so the live process only
   sends the shaken history until the session is reloaded. Messages at or
   after the latest user message are never touched by the hook, so an
   in-flight turn keeps full context. The hook is idempotent: against
   already-shaken history it changes nothing.

**Footer note:** pi's footer context-usage figure is anchored to the
provider-reported usage of the *last* LLM call, so the freed space shows up
there after the next LLM call (any prompt). The transcript and the `/shake`
status update immediately.

**Auto-compaction guard:** pi's automatic (threshold) compaction is triggered
by that same stale anchor, so right after a shake a `continue` could re-trigger
compaction even though the shaken history now fits. The extension listens to
`session_before_compact` and cancels the automatic compaction when the shaken
history is small enough to fit (estimating what the `context` hook will
actually send, plus headroom for the system prompt + tools). This prevents the
compaction→shake→compaction loop. Manual `/compact` and overflow recovery are
never blocked. With a virtual selection or an unknown model API, the extension
does not cancel compaction: the next physical target and its context limit are
not known. Pi performs its own request-time limit checks. On Pi 1.2.0, the
physical-model estimate uses Pi's canonical projected messages, including
context edits, retained history, summaries, and compaction system checkpoints.
Older physical SDKs retain the entry-based estimate.

Elision is **irreversible for the shaken session** — the original bytes are
gone from the file. If you might want them back, make a fork (`/tree`) before
shaking; forks made before the shake keep the full history.

**Thinking safety:** With a virtual selection or an unknown model API,
signed/redacted thinking is preserved, even after a successful physical
response. A later request can route elsewhere. Unsigned thinking, tool output,
images, and long text can still be shaken; `/shake` status excludes retained
thinking from its removal estimate and explains why it is kept.

For a known physical model, the existing policy is unchanged: signed/redacted
thinking is dropped on non-`anthropic-messages` APIs, or when pi sends the
`thinking-binding-controls` beta (`supportsMidConvoEffort`). Otherwise it is
kept for Anthropic replay.

## Install

```sh
# from npm (listed in the pi.dev package catalog)
pi install npm:pi-context-shake

# or straight from git
pi install git:github.com/corrm/pi-context-shake

# try it for one run without installing
pi -e npm:pi-context-shake
```

Uninstall with `pi remove npm:pi-context-shake`.

## Develop / test

```sh
bun install
bunx tsc --noEmit   # typecheck against @earendil-works/pi-coding-agent
bun --no-env-file test.ts # engine tests and offline callers on the local SDK
```

To exercise an already-installed Pi 1.2.0 SDK without changing development
pins, set `CURRENT_SDK_ROOT` to its `pi-coding-agent` package directory. Its
sibling `pi-ai` package must come from the same installation:

```sh
CURRENT_SDK_ROOT=/path/to/node_modules/@earendil-works/pi-coding-agent \
  bun --no-env-file test.ts
```

Offline tests cover physical callers on Pi 0.85.1 and 1.2.0, plus synthetic
native routing and canonical context projection on 1.2.0. No Auto extension is
required. Native-only checks are explicitly skipped with Pi 0.85.1. The tests
use in-memory credentials and faux providers; they do not prove live-provider
signature acceptance, entitlement, or installation compatibility with other SDK
versions.
