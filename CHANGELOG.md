# Changelog

## 1.2.1

### New

- Voice input is on by default on macOS: press `Option+V` to dictate, and manage it with `/voice`
- Added a `/rewind` command that rewinds the conversation to an earlier input — same picker as double `Esc`
- Pasted and dropped images get `[Image #N]` labels the model can see, so you can ask about a specific image by number; labels and their source paths survive resume, rewind, and forks
- `/mcp` shows a live inventory of connected MCP servers and their tools in the transcript
- Added a bundled `migrate` skill that imports your Claude Code or Codex memory notes and MCP servers into Muse Code
- Set `MUSE_TRANSPORT_TRACE=1` to print raw provider request and response lines to stderr for debugging model calls; credentials are scrubbed
- Sessions can be renamed over the session protocol with `session/rename` (with `session/nameChanged` notifications), and `session/list` carries display metadata — title, first user prompt, and branch
- Edit-tool calls on the session protocol carry a structured diff fact — `patchSummary` line counts plus a durable `patchRef` — so clients can render what an edit changed
- Programs driving a session can set a session-wide reasoning-effort default with `session/setReasoningEffort`, inherited across resume and fork
- Workflows now run in `muse serve` sessions, matching what `muse exec` supports

### Improvements

- New sessions start in the Auto-review permission profile: the same access as Ask me, with an automated reviewer deciding eligible approval requests; it falls back to asking you when the reviewer is unavailable
- Permission selections are remembered and applied to new sessions
- MCP tools whose server declares them read-only run without an approval prompt under on-request approvals
- MCP server configs support `${VAR}` environment interpolation, and stdio MCP servers receive `MUSE_SESSION_ID`
- The MCP handshake advertises protocol version 2025-06-18 on both transports
- Hook payloads include the session's canonical `model_provider`, so hooks can branch on the active provider
- Clearer, typed guidance when a sandboxed command is denied listening on a network port
- Messaging local Claude Code sessions is more robust: interrupted sends cancel cleanly, stale late replies are rejected, and peer discovery shows whether a peer supports read receipts
- `session/resume` runs the same startup reconciliation as a fresh launch, so work orphaned by a crash settles instead of staying stuck
- Launching a subagent with an unknown agent type or an invalid task name is rejected with an explanation of what was wrong and which targets are valid
- Every non-Main viewer's footer shows `Ctrl+C` to return, even when the view isn't focused
- Scheduled-task rows keep long prompts to a single header line, and creation receipts are one line, with detail available on expand

### Fixes

- **Security:** commands launched through wrappers like `env` and `setsid` are reviewed as the command they actually launch
- **Security:** changing the permission mode mid-session now applies to already-running tools at their next action
- **Security:** MCP tool grants in custom agent definitions are validated against the prepared toolset instead of falling back to a legacy path
- **Security:** the Unrestricted permission profile now behaves exactly like `--yolo`
- Only the main and side sessions can prompt for user input; subagents no longer can
- Smoother `/clear` and `/new`: the screen no longer blanks before the new session's first frame, keystrokes typed during the restart are kept and replayed in order, and a `Ctrl-C` in the restart window no longer kills the app
- `/clear` and `/new` refuse trailing text on the command line with a usage hint instead of silently discarding it
- MCP servers that fail to start after `/clear` or `/new` now surface the failure instead of staying silent
- Double `Ctrl-D` over a pending approval opens the exit confirmation instead of force-quitting past running background work
- With an approval prompt open and text in the composer, `Enter` goes to your message instead of being swallowed by the approval panel
- Each guarded call in a parallel tool batch gets its own approval prompt
- Permission selections committed during a session survive resume
- Pending approvals survive a headless restart instead of inheriting the predecessor's abort
- After a crash, a tool approval that was still waiting for your answer shows as unresolved on resume — never as already executed
- Saving settings preserves the file's permissions and symlinks, and no longer writes an all-default `tui` block
- MCP `startup_timeout_sec` is honored, and slow servers that emit newline-delimited JSON are admitted
- An MCP server's `required` flag follows the winning configuration layer
- An MCP server's `cwd` setting now sets the stdio server's working directory
- Resuming is more reliable: resume no longer fails after compaction has pruned older history, on a session saved mid-way through parallel tool calls, on a checkpoint taken while a workflow was paused, on a checkpoint that went stale while the session kept running, or with "duplicate or non-monotonic" sequence errors; a run that cannot be rebuilt is set aside instead of blocking the whole session, and an empty saved session file is refused with a named reason instead of opening broken
- A malformed tool call from the model no longer poisons the session: the model gets a clear error it can retry from, and sessions already saved with such a call resume cleanly
- Forks and side chats are more reliable: they stay available after resuming from a checkpoint, keep messages and attachments that used to be dropped from the new branch, open on histories that previously failed with a read error, and branches created in quick succession keep their creation order
- Your model and reasoning effort choices stick: forks and side chats start on the parent's model and effort, a per-turn effort applies to that turn's model requests, and turns the runtime starts on its own (like background-work wake-ups) use your settings instead of the startup defaults
- Stopping and cancelling subagents is dependable across restarts: a stop or cancel in flight when the app closes is completed on the next launch instead of forgotten, stays in force after the agent is closed and reopened, and is not reopened by a late result from the agent's own children; restart recovery no longer revives, duplicates, or corrupts agents it should leave alone, and closing an agent's whole subtree no longer wakes the agents being closed
- Background work reports in reliably: a live view opened before a background task produced output now fills in instead of staying blank, messages for a subagent's own subagents reach the right agent, and a finished subagent whose session can no longer accept results settles instead of waiting forever
- Workflows start and finish cleanly: an invalid workflow source is rejected before anything launches (and `muse exec` JSON output stays clean), a finished workflow agent with a missing or invalid report settles instead of leaving the workflow waiting, and resuming mid-workflow replays already-completed steps correctly
- Workflow progress narration shows in the conversation on the default view, not only inside `/workflows`
- Goals handle blocked work honestly: a goal denied by session policy ends with a clear final message naming what was blocked instead of empty output, and progress that was blocked resumes correctly when the goal continues
- `muse exec` no longer exits with an error when the process reading its stderr goes away during shutdown
- Finished shell commands clean up fully: releasing a captured terminal no longer injects a stray blank line into the command's output, and long sessions no longer accumulate runtime resources from completed commands
- Session storage is more robust: listing sessions no longer intermittently fails with "session index unavailable: database is locked", and a full disk no longer crashes the app before it can restore your terminal and print the session id and resume command
- Pastes into `!` shell mode stay literal — image file paths are no longer rewritten into `[Image #N]` attachments
- Long assistant replies stay within the collapsed row cap while streaming, and `Ctrl+O` mid-stream no longer garbles the elided view
- Tool rows in narrow terminals keep their expand hint instead of dropping it when the header runs out of room
- `/settings` refreshes its rows when a side chat starts or returns, so the Reasoning effort row can't go stale and the highlight can't act on the wrong row
- Messages parked in a side chat no longer linger in the main session's queued-messages panel after returning
- After `/side`, `/status` and `/tasks` count only the visible session's work instead of leaking the other session's subagents and pending items
- `/tasks` preview of a finished terminal shows the same status wording as its drawer row instead of "no output yet"
- Keys pressed while the rewind loading screen is up are absorbed instead of leaking into the composer; `Esc` and `Ctrl-C` still cancel
- Resuming a session by exact id warns when its declared predecessor session is missing from the store instead of resuming silently
- A freshly launched session no longer vanishes from other terminals' resume pickers until it exits
- `/stop` always renders a verdict — a background task that never confirms now reads as a failed stop instead of leaving `/stop` silent
- `muse serve`: `session/list` includes sessions loaded on the answering host with fresh metadata so a new session appears immediately after `session/start`; session recency ignores internal bookkeeping writes, so crashed old sessions no longer jump above newer work; page cursors bind to the listing that minted them, and cursors from live streaming and durable reads share one space instead of being rejected as unknown; `session/setModel` acknowledges only after the change is durable; omitting `providerId` on `session/start` resolves to the host's composed provider; a brand-new session can no longer be pruned out from under its own start; and stopping the server with SIGTERM or SIGINT winds down cleanly, closing sessions durably instead of crashing them
- `muse serve`: a rejected `session/resume` no longer leaves a stray view subscription; resuming with a cursor delivers pending approval and user-input requests instead of an empty list; live view updates re-arm after a `view/unsubscribe`; approval modes selected over the wire are honored for shell commands instead of being clamped; setting the model to the same provider no longer bricks a resumed session; subagent results recorded before a resume are readable again; follow-up turns spawned from a carried-forward `turn/steer` can be interrupted and steered; the `retryable` flag on `turn/completed` errors reflects the provider's real classification; reminder-spawned child tasks show their real lifecycle instead of appearing completed at spawn; and sessions started without a workspace root can still prompt via `request_user_input` when the client supports dialogs

### Performance

- Opening or resuming a long session is dramatically faster: startup work now scales with the size of the session log rather than multiplying by the number of turns
- `item/readOutput` no longer scans the whole session per read — dramatically faster on long sessions
- Re-attaching a live session view over `muse serve` is now constant-time, independent of how many events streamed since load

## 1.1.1

### New

- Added `muse mcp login <server>` and `muse mcp logout <server>`: OAuth 2.1 sign-in for remote MCP servers, in the browser or headless. Tokens are kept in the auth store and refreshed automatically, a login done in another terminal is picked up without a restart, and a startup or mid-session 401 now tells you the exact `muse mcp login` command to run. Set `mcp_oauth_dynamic_client_registration: false` to turn off automatic client registration
- Markdown links render as clickable labels in terminals that support hyperlinks, with automatic fallback (including under tmux); exported transcripts keep the full URL, and links survive redraws and scrollback
- `/theme` gains a Terminal background row: Left/Right cycles auto, light, and dark and re-derives the picker live, a notice appears when your choice contradicts what the terminal reported, Enter saves it as `tui.terminal_background`, and Esc reverts
- The agent can check on and stop its own background work (workflows, subagents, and background commands) with the new `work_status` and `work_stop` tools, using the same work ids it is shown
- Todo reminders are on by default: the model is nudged to create and update a todo list during complex multi-step work
- Two new built-in skills, on by default: one has the agent ask about an unresolved product decision before committing to it, the other keeps a focused regression test with each bug fix or behavior change
- Added a bundled Three.js skill (`/threejs`) with references for scenes, geometry, materials, lighting, textures, animation, loaders, shaders, post-processing, and interaction
- Added a `PostToolUseFailure` hook that fires when a tool call fails or crashes
- After a rewind or fork, the status bar warns while tasks from the original conversation are still running, and the new branch's transcript notes the background work that stayed behind
- Press `s` in a workflow's detail view under `/workflows` to save the running workflow under a name so you can run it again
- Programs driving a session can declare `capabilities.userInputDialogs` at `initialize`; sessions whose client can show a dialog get the ask-the-user tool, and a client that opts out has such calls rejected cleanly instead of hanging
- Programs driving a session can read an item's stored tool output by reference with `item/readOutput`, and re-attach a live view with `view/subscribe` after `view/unsubscribe` on a still-loaded session, replaying the gap from a cursor

### Improvements

- Memory, Skill, Todo, and Scope reminder child logs now default to **Memory only**, so a long session no longer accumulates one `subagent/<id>/session.jsonl` per model step. Choose **Saved** under TBH Reminders → Settings to keep writing them; Goal and Verify are unchanged
- A forced `max` reasoning effort (`--reasoning-effort max`, settings, `/effort max`) is now sent to the model as-is on every model instead of being silently downgraded, so an unsupported value shows the provider's error; `max` is also accepted as a `reasoningEffort` on `turn/start` and `turn/steer` over the session protocol
- The Scope reminder is on by default in sessions using muse-spark-1.2
- Tuned the built-in instructions: the agent asks one grouped question before scaffolding when a request leaves a material product decision open, never claims a server is up without a fresh check, confirms decisive values (versions, config values, paths, counts) by a second route, surfaces degraded external causes in the deliverable itself, resolves which file a correction refers to before editing, and reports rather than refuses safety concerns about explicitly requested changes
- The goal reminder no longer steers the agent toward faking, bypassing, or disabling a test to satisfy a goal; it names the honest blocker instead
- Workflow scripts steer child agents to inherit the parent model unless a task clearly needs a different tier, and research children inspect the source and tests behind each claim instead of stopping after a fixed number of tool batches
- The built-in `grill` skill now records each settled decision in your project docs and closes with a written scope contract (what is in and out of scope, and what done means); the separate `grill-and-record` skill was removed
- The `plan` skill asks about open product preferences up front when you request a collaborative planning checkpoint, instead of leaving them as open questions at the end
- The composer prompt uses a heavier `❯` glyph
- `/new` and `/clear` prepare the new session before shutting down the old one, so both stay resumable if the process dies mid-restart; `/new` now clears the visible thread like `/clear`, both share one palette description, and quitting after keeping background tasks across them warns that those tasks will be stopped
- `--disable-sandbox` no longer prints a startup notice on its own or changes your selected permission profile; startup warns that profile filesystem and network restrictions are not enforced for direct shell commands, and `/status` shows a Sandbox row when it was disabled at launch
- Commands you run yourself with `!` (and `session/userShell` over `muse serve`) no longer trigger approval prompts, including for network access; hard policy denials still apply and stay visible
- Tool calls that fail only because a path does not exist are shown quietly in a dimmed style instead of as loud errors
- Tool cells with several attachments draw one continuous tree guide from the header to the last attachment, and wrapped continuations no longer land at column zero
- The "Worked for" line also shows the local time the turn finished, e.g. `Worked for 1m 01s · 10:15 AM`
- The Plan panel appears only while a run is active and hides while a prompt is waiting for your answer
- When a session wakes for a peer message, the text it writes before calling a tool is folded into that tool row (expand with `ctrl+o`) instead of a separate transcript cell
- Startup notices say exactly what was trimmed: a memory truncation names the file and the limit that fired, and a skill catalog over its size limit keeps every skill's name visible and reports how many entries were cut
- `muse exec` prints once on stderr why subagent delegation is unavailable
- Spawning a subagent whose definition (prompt, skills, memory) already exceeds the context budget is refused up front with a clear diagnostic instead of failing later
- Resuming a session refuses with a named reason and remedy when the saved state cannot be trusted (identity mismatch, another live writer, unreadable state, unrebuildable history) instead of silently degrading
- Resumed sessions describe the current sandbox and permission posture to the model instead of the posture recorded when the session was first started
- The agent's subagent-tree status can page through completed history, oldest first
- `--worktree` sessions remove their Git worktree on close when it is clean and its commits are already on the default remote; unique or unproven work is kept
- Sessions you open and quit before sending anything no longer linger in the resume list or on disk, including zero-turn `muse serve` sessions whose owner process died
- Removed the confusing "model … not in catalog — using assumed limits" notice at startup
- In `/workflows`, press `f` inside a workflow's agent view to filter agent cards by label; the phase drill-down filter is offered only while agents are live and clears itself when the last one finishes
- A turn that fails because no usable credential is available ends with a distinct `authRequired` error over the session protocol and in the SDKs, instead of a generic model error
- SDK: `apply()` session-state outcomes are deeply read-only, and the `DeepReadonly` type is exported
- Shell output containing invalid UTF-8 now notes how many bytes were replaced instead of being rewritten silently
- Selecting the `max` reasoning effort in the Effort drawer plays a gold activation animation, and the gold prompt and rail stay settled across model switches

### Fixes

- **Security:** Closed a gap where `rm -fr`, `rm --force`, and wrapper-nested variants slipped past the dangerous-command check that guards destructive shell commands
- **Security:** Model-authored subagent names and objectives, text read back from an external editor, and provider error messages are stripped of terminal control sequences before they reach the terminal or the session log; provider errors are also scrubbed of credentials
- Sending an image with no text no longer makes every later message in the session fail with "Message not sent", including after resume
- New prompts are no longer rejected after a restart when the session's replay evidence is missing or unreadable, and "Message not sent — projection failed" no longer follows a turn that ran several tools at once and had its results cleared
- A background delivery whose submission keeps failing no longer retries forever or starves your own messages ("Message not sent — runtime admission timed out"): retries are single-flight and a poison item is quarantined after three failures
- Sessions whose log can no longer be fully replayed, whose checkpoint records a wrong message count, or whose saved runtime snapshot is invalid now resume from the last valid checkpoint or a safe reopen instead of failing to open
- Resuming after a checkpoint no longer fails on the next turn, leaves a gap that breaks the next checkpoint, or fails on the first write after a compaction had already summarized a superseded marker
- Resuming no longer aborts when one subagent's log is unreadable, drops the answer the agent gave after a retried turn, shows an interrupted MCP call as completed, or loses a running workflow's agent tree after a compaction
- A resume that fails before it is ready no longer writes partial records to the session log, and a resume forced to fall back after an invalid checkpoint recovers with a single recovery checkpoint
- Reminder-agent logs that end in a blank line no longer fail to replay on resume
- The session list refresh no longer races sessions that are still being written, and keeps a session's cached title and details when its lock cannot be opened instead of showing an "unreadable" placeholder
- The `--resume` picker stays responsive while sessions are still being discovered on a cold start, and resuming from it or after a session-in-use notice shows startup progress instead of a blank pane
- Resume and `muse export` report a permission-blocked session directory as unreadable, with a `chmod` remedy, instead of claiming the session has no saved log
- Running `resume` without a terminal now points to the headless remedy (`exec --session-id <uuid>`), and the export picker names its real `--last` and `--session` flags
- `muse exec --resume` works for sessions created with `--worktree`, records the crash before adopting a crashed session, and `muse exec --no-session-log` starts when subagent delegation is enabled
- Nested subagents (a subagent's own subagents) now open their session logs, write their control records, and recover in the right place across restarts, so their results survive a resume and are not duplicated
- Subagent results no longer point at the wrong transcript when several subagents run at once; interrupting a subagent before its first model call takes effect immediately; waiting on a worktree-isolated subagent after cancelling it no longer errors; reading a subagent's transcript works after its log crosses a checkpoint; and messages a subagent rejects are recorded with the reason
- The subagent panel keeps a Finished marker that arrives out of order, shows the selected subagent's own activity while it waits on the model, expires a finished row you parked the cursor on, names agents by label in steering acknowledgments, keeps its place when paging a completed transcript after a status refresh, and counts each subagent's tokens the same way `/usage` does
- An invalid `subagent_type` value, or a default subagent definition that fails to load, now gets a rejection naming the real cause instead of a generic argument or selection error
- The task inventory shown for a child conversation lists only that conversation's workflows, subagents, and terminals instead of the parent's
- Paused workflows survive: cancelling a turn no longer marks a paused workflow cancelled, and a paused workflow keeps its owner, children, capacity slot, completion state, and resume handoff across `--resume`
- Workflow children report reliably: a child that fails shows its final status live, a finished child stays finished, cancelled children show no error receipt, follow-up subagent results reach the workflow, results are no longer held back behind a long main turn, messages sent to a child before it is live are queued instead of rejected, children woken after a restart no longer stall on reminders, and children keep their memory tools after recovery
- Quitting cleanly while a workflow still has live child work leaves that work recoverable on the next launch, the same as after a crash
- Subagents spawned by a workflow child no longer clutter the main transcript with spawn and finish rows
- Steering a running turn no longer drops Workflow mode when the steer lands as a fresh turn
- `/workflows` shows a short run id next to unnamed workflows so identical-looking rows can be told apart
- Saving a named workflow no longer overwrites a file a concurrent save just wrote, cleans up its staging file on failure, and names the target path in the error
- On Linux, workflow script syntax errors report the real message and source line, keep `--json` output clean, and scripts whose default export is an expression are detected correctly
- Goal controls accepted in the final moments of a turn, or just before a cancelled turn restarted, are no longer left queued; interrupting a run with an active goal reliably shows the goal-paused notice; Esc stops the turn even when goal storage is unavailable; goals closed automatically when a run ends are recorded and announced; and a rolled-back fork no longer leaves goal store files behind
- Rewinding to a point mid-conversation works again; rewind branches from the exact point you chose; a window holding a queued steer or an in-flight run no longer fails after you confirm; sessions compacted mid-turn can be rewound; and a finished task whose result is still being delivered no longer counts as active work
- `/side` no longer fails on a session compacted after its checkpoint, on a log with only bookkeeping records since the last checkpoint, or when resuming a side chat created on an earlier day; a prompt sent right after returning from `/side` is queued instead of rejected as busy
- `session/fork` preserves the source turn and item identities, accepts the source session's real turn ids as the cut point, reports the child's own turn count, and forked sessions over `muse serve` start their MCP servers instead of failing with "MCP startup audit failed"
- Failed turns no longer count as phantom turns in session listings, reads, resumes, and rewinds
- Manual `/compact` summarizes with the model you switched to via `/model` instead of the launch-time model
- `/new` and `/clear` no longer break every following turn with "MCP startup audit failed" when MCP servers are configured, and `/clear` refuses to start a new session when the session log cannot be retained instead of minting one that would lose history
- Enabling or disabling a skill now takes effect on background and reminder-driven turns immediately, not only on your next prompt
- Re-running `/skills import` reports already-imported skills as skipped instead of counting them again (`--dry-run` shows the same rows); a project copy of a bundled skill with identical content is no longer listed twice; and a skill whose manifest cannot be read reports the real filesystem error
- The skill reminder no longer fires in sessions where the `read_skill` tool is unavailable
- One mistyped entry under `skills.activation.projects` or `hooks.state` no longer discards the rest of the map (a startup warning names the bad key); settings and credential writes follow a symlinked config file instead of replacing the link; and a rules directory that cannot be searched is reported by name with a remedy
- `PostCompact` hooks fire exactly once for background compactions adopted after a turn ends; a `PostLLMCall` hook that keeps returning `additionalContext` stops re-driving the turn after 8 continuations; and hook trust and enable state no longer collide between argv-style hooks whose arguments join to the same string
- MCP tool calls keep their server attribution through live refreshes and after closing a rewind overlay; the per-server `tool_timeout_sec` setting applies to tool calls, resource reads, and prompt fetches on both transports; and a server that requires an OAuth sign-in says so at startup, with HTTP 403 reported as an authentication failure instead of a generic initialization error
- Interrupting a running `bash` command returns the output it had already produced; a background command's exit status is shown once; input sent to a non-interactive background command points at `terminate`; starting a second `!` command while one is running names the running command and keeps your draft; and denied `!` commands report output truncation correctly
- Search results in JSON mode return invalid-UTF-8 lines as base64 `bytes` instead of silently rewriting them
- Runaway loops that repeat the identical command with identical output are stopped even when compactions happen mid-loop
- Cron jobs created during a fresh `muse exec` run are bound to that session; queued cron wake-ups are no longer lost when a session is resumed after a compaction; and `muse serve` sessions expose the scheduled-task and goal tools that were advertised but never reached the model
- `muse exec` text output no longer loses the answer when a background wake starts a second run; `exec` no longer hangs on a protected write it cannot get approved; `--max-tool-output-bytes` rejects values below the readable floor (`0` disables the cap); and a failed model-catalog fetch is no longer retried a second time on a cold cache
- Startup no longer fails when the temp directory is unusable (it warns and continues); on Linux the startup warning about a missing system `bwrap` is gone; and `muse init` no longer hangs on a package manifest that is a FIFO
- Meta Model API requests that fail with HTTP 402 are not retried, and retry status reads in plain words, e.g. `rate limited (HTTP 429) · retrying in 60s · attempt 2/10`; a transient token-refresh failure during `web_search` is reported as a connection problem instead of an authentication failure
- Ctrl-B and Ctrl-D edit text when the draft is non-empty and the exit hint follows remapped keys; fast-typed or terminal-buffered text no longer arrives out of order around character-form shortcuts or Tab; cutting a large paste with Ctrl-W and yanking it back restores the content; the cursor no longer drifts after Indic spacing-mark clusters; and an image path in the middle of a sentence stays as text
- Typing no longer stalls right after resuming a long session; idle sessions no longer churn CPU after a turn ends and the terminal cursor blinks again; and opening or answering an ask-question prompt no longer blanks and redraws the whole terminal
- Collapsed read and search summaries always show the `ctrl+o` hint; wrapped lines no longer tear emoji sequences or overflow the pane; narrow panes keep the state cell and timer visible for long task labels; the live-follow view for a background command uses the full pane width; an external tool's failure details render once; and tool rows rejected for bad arguments switch to `rejected` promptly
- Run failures caused by step limits, configuration, environment, or workflow launch errors no longer carry a misleading `model failed` prefix; the context-usage notice no longer reports almost nothing remaining on an implausible token count; and the notice shown when resuming a session that did not shut down cleanly no longer tells you to run `reset`
- `--worktree` sessions no longer fail intermittently when several sessions create worktrees in the same repository at once, and resuming one no longer hits a worktree collision after an earlier removal was interrupted
- `muse export --out` writes to a temporary sibling and renames it into place, so a failed export never truncates an existing file
- Pending approvals no longer flash into the approval list while the automated reviewer is still deciding
- `@muse-code/sdk` bundles its protocol type declarations, so consumers typecheck with `skipLibCheck` off; `Item.turnId` is typed as nullable to match what the server sends
- `muse serve`: protected-write approvals wait for the subscribed client's `approval/decide` instead of aborting right after prompting; `session/resume` re-issues pending approval and user-input requests so a reconnecting client can answer them after a crash; a resume with a cursor no longer lets a live event reach the client before the replayed suffix; and views restored after a restart match the live view when a reply was still streaming at checkpoint time
- `muse serve`: `session/list`, `session/read`, and `session/resume` report `running` and the active `turnId` while a turn is in flight; a session whose cached view history is unreadable reports history as unavailable instead of failing every read; failed, cancelled, and timed-out tool calls include the tool's final output; `session/start` ignores unknown keys inside `config` instead of failing; rejected `userShell` commands are settled durably so an identical retry gets the original answer; and a queued follow-up left stranded when the connection closed mid-admission is no longer executed on the next load
- Scheduled (cron) deliveries run as one bounded turn: the end-of-turn goal reminder no longer fires on a scheduled run, which had kept a single delivery looping through phantom ticks every few seconds
- A `muse serve` host that started logged out now picks up a later device-code login on the next session start, resume, or fork instead of answering "auth required" until the host restarts

### Performance

- `view/page` on long sessions is dramatically faster over `muse serve`: page reads are linear in session size and repeat pages on a loaded session are served from cache
- Faster startup and resume: multi-megabyte checkpoint lines are read in linear time, session-index housekeeping and crash-recovery scans run after the prompt is ready, the trust store is read once per launch, a turn submitted into a resumed session no longer replays history older than the last compaction, and `session/resume` over `muse serve` loads from the latest checkpoint instead of replaying the whole log
- Rewind evaluates and applies from an in-memory window of the current conversation (back to the latest compaction checkpoint) instead of re-reading the session log, so the picker opens faster in long sessions

---

Also delivered in 1.0.x patches: the `tui.terminal_background` setting (`auto`, `light`, or `dark`); `muse serve` sessions expose the same `bash` tools as `muse exec`, `model/list` lists only the models a session can route to, `session/resume` from a cursor delivers the retained events after it, an oversized `session/start` workspace path is refused and `session/list` pages large listings, `initialize` rejects a malformed `clientInfo.name`, and `muse serve` exits with code 3 when settings or credentials cannot be loaded; forking carries compacted permission state into the fork; forked and side sessions show their real creation time instead of 1970; web search reads compressed responses; logging out clears the cached feature configuration; the skill reminder is active again in default `muse exec` runs and no longer repeats its loaded notice; the blocking verify reminder header reads "Double checking"; resume tolerates a blank line in the session log; checkpoint and explicit saves no longer stall behind background flushing; memory writes survive a stale temp file left by a crash; subagent results and goal reminders arrive as developer context; the search tool routes filename lookups to `glob`; Esc exits input-history browsing and restores your draft; `/resume` inside the app shows startup progress instead of a frozen screen; the `/tasks` drawer lists only the visible session's tasks; a retried `turn/interrupt` after a restart no longer records a duplicate rejection; and two security fixes: on-request approval mode requires approval when shell arguments cannot be fully parsed, and provider error messages no longer include the credential that failed.

## 1.0.3

### New

- Added a `max` reasoning effort for the muse-spark-1.3 family: pick it with `--reasoning-effort max`, `/effort max`, the Effort drawer, or `/settings`

### Fixes

- The `ultra` reasoning effort is temporarily unavailable: a configured `ultra` (setting, flag, `/effort`, or managed default) now runs as `xhigh` with a one-line startup notice, and the Effort drawer no longer lists it
- **Security:** `muse serve` now applies the `permissions.default_profile` setting from settings.json; a profile configured there (such as read-only) was previously ignored, letting served sessions write files with no diagnostics
- Completed tool calls from non-streaming tools (file reads, searches, MCP tools) include the tool's output on the session protocol, so clients can show what the tool returned
- A session that ended abnormally can be read back and resumed instead of failing to load
- `session/compact` works on resumed sessions instead of failing every time
- A session's approval mode is readable without attaching: fresh-session acknowledgements, broadcasts, and `session/read` now carry it
- Forking a session keeps a user message that arrived mid-turn instead of dropping it from the fork
- Messages received but not started when a session ended are settled as abandoned on reload instead of being re-executed
- Compaction items report whether compaction was manual or automatic; manual compaction was always reported as automatic
- Turns skipped over unsupported or oversized content no longer change which run `session/compact` targets after a restart
- Startup no longer stalls silently for many seconds probing Git storage; a pinned-storage problem is reported as a diagnostic instead
- Resuming a session works when the goals database file is absent instead of failing every resume
- An account-restriction error from the model API shows support guidance instead of a bare policy-violation failure
- Long-running sessions no longer fail with "runtime command acknowledgement timed out": flushing the terminal audit log no longer blocks command handling

## 1.0.2

### Improvements

- The agent treats a change as done only after the repo's own tests for the touched area pass in-session, and checks every requested behavior against the real code before finishing

## 1.0.1

### New

- Resuming a session shows its progress — reading the session log, restoring the conversation — instead of a blank screen
- Added a `SessionEnd` hook that runs when a session ends
- Added a `Notification` hook that fires when the agent needs your approval, so a script can alert you
- On macOS, sign-in credentials are stored in the system Keychain instead of a plaintext file
- The agent is warned as it approaches its step budget, so it wraps up instead of stopping mid-task
- Pressing Esc repeatedly in an empty session now tells you there is nothing to rewind
- The agent no longer scaffolds a new project into your home directory or an already-populated folder
- The TypeScript SDK is published: `npm install @muse-code/sdk`. Node 20 or newer, zero runtime dependencies
- Developer documentation is public at https://meta-models.github.io/muse-code-sdk — quickstart, cookbook recipes, and a generated API reference
- `muse serve` and `muse schema` are available by default; driving a session from your own program no longer needs an experimental switch
- The session protocol has a published, stable v1 schema: connect to a session, drive turns, and fold the event stream against a documented contract
- Two sessions on the same machine can message each other. The agent can list your other sessions and send one a message, and you approve the first message from each unverified sender before it lands. Name a session with `/name` so others can address it
- Workflows, on Linux: the agent can write and run a deterministic script that fans a large job out across focused agents working in parallel, then folds their results into one answer. `/workflows` browses runs, `/tasks` shows each run's progress and its agents, and a setting controls whether a workflow may start on its own, only when you ask, or never
- Slash commands complete inline as you type
- Press Ctrl+O at an approval prompt to read the whole command before deciding
- Output from a `!` shell command streams into the transcript while it runs instead of appearing only at the end
- Programs driving a session can send a running task to the background, stop one, or stop them all
- Programs driving a session can set, edit, clear and read a session goal, and are notified when it changes
- Startup tells you when one project rules file is shadowing another
- Dragging or pasting an image into the composer works under WSL

### Improvements

- Search treats your pattern as literal text by default, so punctuation-heavy queries match instead of erroring
- Raised the per-turn step limit so long tasks are no longer cut short
- Git commands against the repository you are working in now run under the managed sandbox instead of being blocked
- Compaction clears eligible tool results from earlier runs in the session, not just the current one
- Resuming a session restores the main conversation only; earlier side chats no longer reattach automatically
- A typed draft is kept when you browse input history
- Folded command groups preview the titles of the most recent commands inside them
- The task tree shows a shell command's description instead of its raw wrapper text
- Subagents that share a role are numbered, so duplicates are easy to tell apart
- Removed the agent-profile notice that appeared at every startup
- Raised the context budget for subagent delegation rules so larger guidance files are not truncated
- The rewind picker explains why a point cannot be restored exactly, instead of only showing a count
- Skills with unrecognized frontmatter fields warn instead of failing silently
- The built-in git skill honors an explicit commit request stated anywhere in your task
- Scheduled prompt activity shows a compact time relative to the current message
- Background work started before a rewind is labeled as continuing under the original conversation
- Clearer message when a stop or steering command sent to a subagent is rejected
- `/usage` omits the cost figure when cost data is unavailable, and the model picker hides an empty pricing legend
- The built-in Scope reminder is off by default
- Clearer instructions for the shell tool
- `/status` counts activity from live work, so its numbers match what is actually running
- Subagent rows in `/tasks` show a stable number and description instead of a raw identifier
- Task rows no longer spend width on columns they do not draw, and stray control characters are stripped from row tails
- A finished subagent's timer freezes at its own runtime instead of ticking on
- After Esc, the "still running" notice counts only the tasks that actually survived
- The working-status indicator and its shimmer animate in step
- A drawer tab summary that does not fit is truncated instead of blanked out
- The footer stops offering "select" while there is a draft in the composer
- A denied command header is ellipsized in a narrow terminal instead of overflowing
- The read-only legend in the live-output view is no longer cut mid-marker
- `/usage` refreshes your subscription details on the spot instead of showing cached numbers
- `--worktree` with an empty value explains the fallback instead of refusing the command
- Startup reports bundled skills that failed to materialize, and a sandbox scope that failed to build, instead of passing over them
- An unreadable goal store reports the real reason — permissions, a held lock — instead of claiming the database is corrupt
- A corrupt line in a session log is named exactly instead of failing anonymously
- On exit, the resume hint falls back to a session id that works when the canonical one cannot be written
- `trace inspect` reports a recording it cannot read as a failure, and labels each timeline so overlapping runs can be told apart
- Long sessions driven over the session protocol compact their context the same way one-shot runs do, instead of growing until the provider rejects the request
- Listing past sessions is index-backed and pages through large histories instead of scanning every session
- Tool calls are accepted when an argument arrives as a string instead of a number or boolean, or as a single string wrapped in an array
- Optional protocol fields accept both omission and an explicit null
- A session command that misses now answers with the real state — already closed, wrong lane, nothing running — instead of a blanket "session not found"
- Clients are told when a session closes because it went idle or the host shut down, instead of the connection just going quiet
- An empty history reply says why it is empty
- Message and tool output stream incrementally over the session protocol instead of arriving only at completion
- Sessions created by older builds can be addressed by lifecycle commands again, and new session and command ids are time-ordered
- A frame with no id can no longer reach a request handler
- A session view observes only its own session's stream, so other sessions' events do not bleed into it
- Stopping a turn when nothing is running is rejected honestly instead of acknowledging a turn that never existed
- Re-sending an identical turn or steer that was already rejected returns the original rejection instead of a command-conflict error
- A duplicate in-flight subagent steering command is reported as retryable rather than fatal
- A queued follow-up task for a subagent carries its caller, so later attempts are accepted against the right parent
- Notifications arrive in the order they were emitted even when they travel through separate outbound queues

### Fixes

- **Security:** credentials are withheld when a redirected or downgraded `--base-url` would send them to an untrusted host
- **Security:** file read, edit, search, and write stay inside the workspace even when the sandbox is disabled
- **Security:** a write that matches no approval rule is denied under a deny-by-default policy instead of being allowed
- Quota-exhausted errors fail immediately with a clear status instead of being retried
- Provider errors keep their real status when the error body can't be read, and no longer surface raw parser text
- A response missing its model field no longer triggers an unnecessary retry
- A generation failure immediately after a reasoning step is now retried
- A transient provider error while summarizing no longer ends the whole run
- Automatic summarization no longer fails when the provider uses a namespaced tool-call name
- Hitting the context window no longer wedges the session; it retries once with a trimmed request
- Context limits and conversation replay update correctly after switching models mid-session
- The rate-limit indicator no longer clears incorrectly after you cancel a rate-limited request
- Cancelling a response no longer emits a few leftover events afterwards
- Tool calls are accepted when the model sends a boolean or duration as a string
- `--help` and usage text show the name you actually invoked the binary as
- Startup fails fast with a clear error when a settings or config file isn't a regular file
- Startup no longer crashes when standard error is already closed
- Startup no longer rejects a project path that is a symlink, or a workspace reached through an aliased path
- Session worktrees keep track of a nested working directory when you start from a subdirectory
- Startup falls through to the login screen instead of hard-failing when credential checks disagree
- Login-failure messages no longer show internal wording when a saved login has expired
- `/status` reports an in-session API key that failed to persist instead of naming the previous account
- A misplaced command used with `--last` now gives an accurate error
- Trusting a project from two places at once no longer loses one of the decisions
- The workspace trust prompt renders non-printable characters in a path visibly
- Startup no longer hangs when the session index is locked by another running instance
- A corrupted image passed with `--image` no longer prints raw decoder internals
- The Linux sandbox falls back to its embedded helper binary correctly, and reports a stale mount clearly instead of failing generically
- Sandboxed Linux commands work when a cached sandbox image is retained
- Approval prompts trigger correctly for `rg` with certain flags, and prompts for protected writes now appear promptly
- The shell tool honors an external working directory when sandboxing is off for that command
- The shell tool acts on the session's live permissions instead of stale approval state
- The shell tool reports an error instead of silently accepting input after a session has finished
- The file-editing tool accepts a patch whose leading chunk is context used to anchor a later change
- Search no longer fails an entire multi-path request when one path doesn't exist
- Resizing the terminal no longer stalls the redraw or flashes the screen
- Scrollback is no longer erased by transient resizes or when you file a report
- The terminal is restored cleanly if you exit while the app is still starting
- Quitting with a double Ctrl-D no longer leaves stray escape sequences behind
- Keyboard input is no longer occasionally dropped on Linux
- The terminal no longer jitters while several tools run in parallel
- Queued messages stay below the to-do list instead of overlapping it
- A to-do update no longer erases scrollback when it collapses an unsent draft
- Background capacity warnings no longer land inside your in-progress message
- Scheduled-task warnings no longer corrupt the display while you type
- The transcript shows the full text of a large pasted block
- Tool call previews show formatted durations instead of raw values
- Fixed a missing space in the goal status line, and spaces now appear while you edit a note in a prompt
- An image sent with no accompanying text no longer disappears from the transcript
- An image dragged into the terminal is no longer rejected when macOS hides its file metadata
- A typed `@mention` that matches no file is treated as plain text, and Enter submits instead of doing nothing
- A queued follow-up message no longer hangs instead of running
- Cancelling a turn just as it starts no longer blocks a clean shutdown
- A burst of queued background work no longer fails other in-progress turns in the same session
- Input sent while a background run is being delivered is no longer dropped
- A follow-up run now updates correctly after a live run in the foreground
- Interrupting before the model produced any output now leaves a visible trace in the chat
- A completed reply is no longer mislabeled as interrupted when you quit just as it finishes
- Esc during the end-of-turn wait no longer interrupts a reply that was already committed
- The prompt timeout no longer fires right after you interact with a prompt
- Cancelling right after compaction no longer drops earlier conversation history
- A stale "agent restarted" notice no longer appears after a manual compaction settles or fails
- A finished subagent no longer stops delivering queued messages and appears stuck
- Follow-up messages to a subagent are no longer rejected after a resume, or dropped when sent just before it finishes
- A subagent's transcript no longer gets stuck and stops refreshing, and stale reads at the end of it are fixed
- A subagent's final result no longer renders twice, and is no longer duplicated or dropped during a retry
- Subagent results are no longer lost after a crash, and recovered results load fully before being selected
- Resuming with more in-flight subagents than available capacity no longer crashes
- Subagent identity is bound correctly when a spawn is replayed after a resume
- `/exit` no longer abandons a subagent that had just been spawned, and exiting is no longer blocked by one that already finished
- Commands that only work in the main conversation are properly rejected inside a subagent's view
- Completed subagents are cleaned up in long sessions instead of accumulating
- Resume no longer replays subagent tasks that had already completed
- Follow-up messages are no longer lost when resuming a session that used subagents
- Background task rows settle instead of staying stuck on "running", and a failed or cancelled task no longer shows as completed
- Cancelled or retried tasks no longer leave stale entries in the task list
- Task-tray rows no longer linger after you navigate into a rewound subagent conversation
- Pending background tasks no longer block a clean session end
- A queued but unstarted background command is no longer treated as an interrupted run on resume
- Stale reminders no longer keep firing after a background task refreshes
- Background task ownership is no longer confused after a mid-session restart
- Output from `!` shell commands and background terminals keeps its place on resume
- A subagent tree hint is no longer lost on resume, and stale queued-message rows no longer reappear
- Pressing Enter during resume no longer submits before the session is ready
- The resume picker no longer offers an already-active session, a stale preview, or an empty one
- A forked session's resume preview shows its prior history, and resuming a forked session is no longer wrongly rejected
- Resume no longer fails on an expected gap in checkpoint history, and falls back gracefully on an unsupported checkpoint format
- Images sent earlier in a conversation no longer disappear from context after a resume or fork
- A resumed session no longer stays stuck after hitting a no-progress limit
- Sessions forked just before a crash are correctly recovered as crashed
- Exiting a resumed side chat no longer overwrites the main session's saved history
- Tool call results are no longer misrouted after a restart
- Tool search history is preserved across resume and compaction
- Resume no longer loses the conversation summary from an earlier compaction, and token usage carries across compaction-linked turns
- Rewind keeps earlier turns that included image or pasted attachments
- Rewind no longer loses prior chat history or shows duplicated, stale transcript content
- Subagent history no longer disappears after rewinding and resuming a conversation
- Rewind requires explicit refill text instead of silently reusing earlier input
- A failed subagent-view load during a rewind can now be cancelled instead of getting stuck
- Rewinding now hands off fully into the session it creates
- Retained goals pause correctly when a session is reopened, and stale goal progress is rejected
- The agent no longer misreads an earlier short reply as the answer to a question it asked later
- Session permission settings carry over correctly when you fork a conversation
- `/feedback` no longer asks you to resubmit feedback that was already received
- Skills are readable when you run with a named toolset instead of the default one
- A context-compaction override passed on the command line is applied instead of silently dropped
- Terminal and one-shot sessions publish and serve their history; previously a new session failed closed at its first record and its history came back empty
- Saved approval rules apply to sessions served over the protocol; previously every persisted rule was silently ignored there, and a corrupted rule store now fails startup instead of being skipped
- Approvals in a freshly started served session are visible and decidable instead of parking invisibly until the turn was aborted
- An approval accepted while a session is still starting advances the pending state on the wire, so a client's approval queue no longer stalls
- Each approval resolution is emitted once, so clients no longer receive duplicate approval events
- Queued turns, steers and approval decisions are acknowledged only after the record is durably on disk, so a crash right after submit cannot lose them
- A rejected model change, approval-mode change or goal change is recorded against its own request, so a retry after a restart replays the original result instead of failing with a conflict
- Starting a session records the approval mode actually in effect, and a session with an empty log reports its mode as a startup default rather than a replayed value
- Starting a session without naming a model gets a server-chosen default instead of failing
- A session reports the model actually in effect, not a stale startup selection
- A read reflects the caller's own just-confirmed writes, so a client no longer reads back stale state right after a successful write
- Resuming survives a hard crash, an unfinished subagent, or a task that was still in flight; a session store copied from another machine is refused with a clear message instead of silently attaching
- Resuming a compacted session works: it loads, your next prompt stays its own turn, and the turn count is accurate
- Resuming from the terminal restores your place, your queued drafts and your goal, and no longer replays the same startup work twice
- A session created before the sidecar format builds its sidecar the first time it is opened
- An unreadable session view reports "unavailable" instead of a bare internal-error code
- A corrupt line in session history is skipped instead of breaking history loading
- A forked session inherits the source's model, permission profile, committed message order and tool-call history
- A fork that fails to start is fully removed, including its leftover database side files, instead of leaving a phantom resumable session; an oversized history budget is honored instead of ignored
- **Security:** a workspace `.git` that is a broken symlink stays in the sandbox deny list instead of quietly dropping out of it
- A provider that rejects the summarizing request no longer wedges the session: compaction falls back to a local summary instead of re-sending the same doomed request every turn
- Compaction stops re-running when it cannot free more context, and no longer discards output that had not been delivered yet
- Manual compaction keeps the same evidence every time instead of varying with incidental request details
- A hook that returns malformed decision output, or a bare scalar where a decision was expected, fails closed instead of being read as an allow
- A `PostToolUse` hook that asks to stop now stops after the finished tool result and any hook-supplied context are kept, instead of discarding them
- MCP tool calls have a real transport deadline and cancel cleanly instead of hanging
- Switching models mid-run no longer misses the selection anchor
- A restarted queued turn answers the original start acknowledgement instead of minting a new one
- A rate-limit response whose retry hint is an HTTP date is honored, so retries wait the advertised time
- Token usage sent as a whole-number decimal decodes instead of failing the response
- Wide characters — CJK, emoji — no longer misalign columns in the command drawer, the picker, the workbench and the task list
- Emoji and other multi-character clusters no longer leave stale cells behind while the composer redraws
- Backspace, delete and the arrow keys move over whole characters instead of splitting them
- Text typed while watching a background command's live output stays with that view instead of leaking into the composer on exit
- A running workflow no longer appears twice in the task list, a finished workflow whose agents failed says so instead of showing as a clean success, and an interrupted workflow resumes its in-flight agents instead of losing them
- Repeated unanswered messages to the same session stop automatically instead of looping, and the limit is shown in the transcript
- A session worktree removal cut short by its time budget completes instead of being recorded as failed
- The session host no longer exits with a spurious error code when its input stream closes; shutdown drains cleanly

### Performance

- Long sessions no longer creep up in CPU and memory, which had been delaying scheduled reminders and background results
- The interface no longer slows down or pegs the CPU once many subagents or completed background tasks have accumulated
- Faster sessions with many subagents, by removing repeated full scans of the subagent list
- Faster resume for sessions with long run histories
- Resuming a session with no checkpoint no longer re-reads the whole session log many times over
- Faster startup by reusing the cached model list instead of re-reading it from disk
- Long sessions no longer slow down as they grow: session progress is tracked as new records arrive instead of being recomputed from the whole history each time
- Turns start faster: what carries over from the previous session is worked out once instead of re-read every turn
- Startup no longer stalls on terminal colour detection; the foreground and background probes overlap under a short cap
- An MCP server whose output arrives in fragments is read incrementally instead of rescanned from the start
- The skills catalog is built once at startup and reused, so skill lists stay consistent across the settings overlay, imports and slash commands
- Startup opens the session lock once instead of repeatedly
- Startup does less redundant work: one repository snapshot instead of repeated git subprocesses, the settings file read once, and the credential file opened once
- Opening a session assembles its history once instead of several times
- Starting a turn in a long-lived session no longer re-scans the whole session log first
- Rechecking overdue background tasks no longer re-reads the session history
- The task and subagent tree stays responsive as the number of tasks grows

## 0.2.1

### New

- Rewind the conversation with a double Esc — pick an earlier point, confirm before anything is undone, and only safe rewind points are offered
- Automatic approval pre-screening: a model-based reviewer clears tool requests it judges safe, so you see fewer prompts. Anything it doesn't clear still comes to you, and it can be disabled
- When the sandbox blocks a command, the agent can ask for a one-time approval to run that exact command outside it
- Added a "Review plan" action to step through long plans that overflow the panel
- Added `muse config` to validate enterprise-managed configuration documents
- Added a built-in skill for setting up isolated Python environments
- Added a built-in skill for handing off and verifying browser apps the agent builds
- Hook commands now receive a selected set of environment variables
- The input box can show a short contextual hint after a turn finishes

### Improvements

- Approval dialogs wait for a pause in your typing before appearing, so they stop stealing keystrokes mid-sentence
- Permission decisions are retained in the session log and restored on resume
- The resume picker surfaces sessions that were previously hidden
- `--model` accepts any model id; unknown ids use sensible assumed metadata instead of being rejected
- Settings accept the standard `mcpServers` key, matching the common ecosystem format
- MCP configuration across multiple files and scopes merges consistently
- Clearer diagnostics when an MCP server fails to start, reported once instead of pinned in the interface
- Optional MCP servers that fail at startup no longer spam the transcript
- You can see which of your hooks are running in the live activity area
- Messages sent as a turn finishes are delivered together in one follow-up turn
- Text typed as part of a rewind is kept and restored
- The agent can ask longer questions, up to 500 characters
- The Write tool flags when a new file nearly duplicates an existing one
- Sessions at Ultra reasoning effort default to maximum parallel-agent capacity unless you set a limit
- Session export stitches in subagent transcripts that finish independently
- Redesigned `/status` as a cleaner summary card
- `/usage` and `/models` label costs explicitly as USD
- Skill slash commands are highlighted while you type
- Tables stay narrow enough to read in a terminal
- The bundled plan skill researches sources first and presents the plan for review before starting work
- Rewrote the built-in plan, doctor, and source-control skills with clearer guidance
- The design skill reliably engages before the assistant writes visual web frontend code
- Within a session, the agent remembers which skills it already read and avoids redundant re-reads
- Skills with aliases appear once under their canonical name
- `skills import --from` errors now list the accepted values

### Fixes

- **Security:** a malicious repository's git configuration can no longer run arbitrary commands
- **Security:** git commands on your repos ignore repo-configured hooks, so a malicious repo can't run code through them
- **Security:** skill text containing hidden terminal-control characters is rejected, preventing display spoofing
- **Security:** Linux sandboxed commands can no longer reach host services through Unix-domain sockets
- **Security:** a folder carrying both Mercurial and Sapling metadata is no longer probed for repository status
- Fixed a crash when resuming a session whose background agent run couldn't be re-read
- Fixed a panic when piping output into commands like `head`
- Fixed a crash on non-UTF-8 command-line arguments
- Partial model responses cut off mid-stream are kept and marked incomplete instead of lost
- Model calls fail fast with a clear status when the network is down, instead of hanging through silent retries
- The working indicator and retry countdown stay visible when a response drops mid-stream
- Streamed answer text no longer appears in the wrong place before the response type is known
- HTTP/HTTPS proxy environment variables are respected for all network traffic
- Keystrokes are no longer lost while an approval decision is submitting
- Multi-line pasted text stays together, including in terminals without bracketed-paste support
- Fixed shifted keys being misread in older VS Code terminals
- Prompts typed in quick succession while a run starts are accepted instead of dropped
- Prompts appear in the transcript as soon as you submit them, even while the run is still starting
- Ctrl-C withdraws queued messages that hadn't started yet
- A steering message you already sent is no longer lost when you retract the turn
- Retracting a turn just after a steering message went through no longer freezes the interface
- Prompts entered when forking a session run in the forked session, not the original
- Esc interrupts the end-of-turn reminder wait instead of appearing to hang
- Tools no longer time out while waiting for you to answer an approval prompt
- Resume restores permission prompts that were still awaiting an answer
- Resumed sessions keep the approval mode you chose
- Permission prompts stay visible when the side panel refreshes
- Denying a network permission request now tells the agent and shows in the transcript
- The automatic permission reviewer is more predictable, with consistent verdicts, retry caps, and timeouts
- `/compact` compacts the session's real working set, including after forks and side chats
- `/compact` runs in the background instead of blocking the session
- Branching into a side chat after a restart no longer breaks conversation history
- Resume replays subagent activity recorded in the parent session log, with the original identity
- Resumed sessions keep subagent lifecycle events in their original order
- Output from background subagents started before a resume is replayed instead of disappearing
- Subagent results that finished before you pressed Esc are preserved instead of disappearing with the cancelled turn
- Long-running background subagents reliably deliver their final answer
- Input submitted just before the app stops is no longer stranded on resume
- Resume no longer writes checkpoints from a half-replayed log, or breaks on expected gaps in the checkpoint log
- Resume no longer risks adopting the wrong `/compact` result during recovery
- Manual `/compact` runs are recorded durably and survive restarts
- A log truncated mid-write no longer restores a partially written permission record
- Session goals are restored with working controls after a kill and resume, and usage totals stay correct when a goal is replaced
- Resumed session goals restore their usage totals instead of failing to resume
- Session goals pause when successive turns stop making progress, instead of looping indefinitely
- Exported sessions keep the full record of permission prompts and decisions
- Sessions get a proper end record on normal exit, keeping history and resume listings accurate
- Closing or losing your terminal is no longer misreported as a crash
- Starting two sessions at the same moment no longer fails to open the local session store on a first run
- Starting from a missing or unreadable folder fails immediately with a clear error
- A prompt passed at startup is no longer occasionally captured as blank
- Fixed a race at run start that could leave the session in a confused launch state
- Headless runs pass your prompt text through unmodified by default
- A `!` shell command whose process dies unexpectedly settles cleanly instead of leaving the session stuck
- Background processes are cleaned up more reliably when a session exits
- The agent gets correct guidance for backgrounding commands from the shell tool on macOS
- Stopping a background task no longer hangs when two stop requests race
- Background reminder checks are tied to their own run, so no activity lingers after it ends
- Headless runs no longer hang after finishing because an older reminder task is still open
- Background command and task ids are globally unique and time-ordered
- Scheduled tasks with a timezone problem warn once instead of every tick
- A corrupt scheduled-task database now warns at startup and identifies where the quarantined data was retained
- A failed subagent launch no longer permanently consumes a capacity slot
- Subagents that finish without a result show a proper final state
- Notes typed in a subagent's view reach the running subagent
- Subagent worktrees whose ownership can't be proven after a crash are quarantined instead of wrongly cleaned up
- Status lines for cancelled and waiting agents show the agent name instead of a raw UUID
- Messages with pasted images sent while the agent is busy arrive in order
- Pasting an image alongside a pending rewind routes correctly
- Hook output starting with a UTF-8 BOM has its allow/deny decision honored
- Project hooks take effect as soon as you trust a folder, without a restart
- Hooks triggered by `!` shell commands are durably recorded and survive resume and export
- Structured JSON output from file hooks is preserved instead of flattened
- Rejected hook output produces a bounded, readable diagnostic
- Shell approval prompts keep the command's original line breaks
- Invalid todo-list tool arguments produce a proper structured error
- A malformed skill on/off value in settings is ignored gracefully instead of breaking loading
- Prompt hints only suggest commands that exist in your session
- A symlinked user config directory no longer breaks loading of project and built-in agent definitions
- Fixed a settings file lock held longer than needed, which could block later writes
- Ctrl-L clears the screen without redraw artifacts
- `/help` shows the full shortcut list in an 80×24 terminal
- Fixed a wildly wrong elapsed time in the activity row after reattaching to a session
- The task panel no longer glitches while old checkpoints are retired
- The Ultra reasoning-effort display and activation animation no longer pop, flicker, or dim
- On Linux, the command sandbox is selected once at startup so behavior stays consistent for the session
- The built-in doctor skill's session-evidence collection and redaction work correctly again

### Performance

- Faster startup with a large skill catalog, and an accurate count of skills dropped from the catalog
- Git operations for isolated subagent worktrees no longer block the agent runtime

---

Also delivered in 0.1.x patches: attaching the session recording when reporting a bug as well as a bad result; correct truecolor detection for Ghostty over SSH; reliable replay of terminal command output in long sessions; subagent results shown once with the correct outcome; and a rollback of a built-in instruction change that had regressed answer quality.
