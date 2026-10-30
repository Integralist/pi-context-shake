# pi-context-shake

A [pi](https://pi.dev) extension that frees context space by shaking heavy content
(tool output, images, thinking) out of the session history — like omp's `/shake`,
but for vanilla pi. It **rebuilds the session in place**: the session's `.jsonl`
file is rewritten atomically and re-read by the running session manager, so the
persisted history and the transcript are the shaken version (and any later
`/resume` opens it). A `context` hook keeps the live LLM payload shaken.

## Commands

| Command | Effect |
| --- | --- |
| `/shake` | Show status; hides on the next prompt |
| `/shake hide` | Hide the status panel |
| `/shake tools` | Elide large tool results, Bash output, and text |
| `/shake images` | Replace images with one-line placeholders |
| `/shake thinking` | Drop reasoning blocks where replay permits |
| `/shake all` | Apply every mode in one rebuild |
| `/shake auto on` | Opt in to checkpointed recovery at 50% context |
| `/shake auto off` | Disable recovery and cancel a pending request |
| `/shake auto` | Show automatic recovery state |

## Automatic recovery

Run `/shake auto on` to enable recovery for this session runtime. It is off by
default and after reload, resume, or session replacement. Execute-plan `auto`
mode does not enable it. `/shake auto off` cancels a pending recovery.

At **50% or above**, the extension asks the agent to stop launching work,
finish the current mutation, collect active subagents/checks, and save a
checkpoint. The checkpoint references existing plan and execution artifacts
and preserves the request, scope, approvals, mode, evidence, Git state, and
next action. A one-time acknowledgement confirms readiness. The extension
checks the checkpoint shape and the agent's safety attestation; it cannot
independently discover detached workers or verify the truth of that summary.

After the run becomes idle, recovery saves an original-session backup, invokes
the same rebuild as `/shake all`, and requests a read-only reload of the
checkpoint and execution artifacts. A fresh read-only Git snapshot supplies
HEAD, status, and tracked-diff fingerprints; the extension checks them again
before resuming. Untracked names are included, not their contents. Mutation
tools and codemode are blocked during reload; use the direct read tool. Only
after an acknowledged reload with valid usage from that response and **fresh
usage below 50%** does it continue the saved next action. It rearms after fresh usage
falls below **40%**; rising back to 50% without that headroom requires handoff
instead of repeated shakes. Unknown usage never triggers an initial recovery.

Unsafe checkpoints, aborts, queued input, changed session or Git state, branched
sessions, rebuild errors, and insufficient fresh headroom stop recovery. A
checkpoint or reload that takes 24 model turns also stops, avoiding unbounded
retries. It writes a temporary handoff when a checkpoint exists and reports its
full path. No new session is created automatically. New user input supersedes a
pending recovery; original approvals and completion gates still apply.

Checkpoints, handoffs, and backups live in a private OS temporary directory.
Backups contain the original, potentially sensitive history. They are not
committed or automatically deleted; remove them when no longer needed. Manual
shake commands still have no automatic backup. Automatic recovery is tested
on Pi **1.4.0**; unsupported older versions refuse opt-in. Recovery requires
a Git worktree with a committed HEAD and a direct read tool; manual shake
retains its existing scope. SDK embedders must bind command-context
`waitForIdle` to their session, as the CLI does.

## Manual thresholds

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
gone from the file. Automatic recovery keeps a private original-session backup.
Before a manual shake, make a fork (`/tree`) if you might need the originals;
forks made before the shake keep the full history.

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
bun run test       # engine, recovery, and offline callers on the local SDK
```

To exercise an installed current SDK without changing development pins, set
`CURRENT_SDK_ROOT` to its `pi-coding-agent` package directory. Its
`pi-ai` dependency must come from the same installation (nested or sibling):

```sh
CURRENT_SDK_ROOT=/path/to/node_modules/@earendil-works/pi-coding-agent \
  bun run test
```

Offline tests cover physical callers on Pi 0.85.1 and 1.4.0, plus synthetic
native routing and canonical context projection on 1.4.0. No Auto extension is
required. Native-only checks are explicitly skipped with Pi 0.85.1. The tests
use in-memory credentials and faux providers; they do not prove live-provider
signature acceptance, entitlement, or installation compatibility with other SDK
versions. The current-host recovery test exercises the full checkpoint,
backup, rebuild, read-only reload, and automatic continuation against the real
SDK with a faux provider; it does not prove that a live model will faithfully
write or reload the checkpoint. Without `CURRENT_SDK_ROOT`, that integration
case is explicitly skipped; the recovery protocol tests still run.
