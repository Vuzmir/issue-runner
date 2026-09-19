# issue-runner

A scheduled GitHub Action that walks a repository's issue queue one issue at a time and hands
each one to Claude Code.

Its point is what it does **not** do. The decision about whether there is work is made from
labels, pull request state and check conclusions. A tick with nothing to do costs a handful
of API calls and never starts Claude, so the queue is billed for work and not for looking.

## Using it

```yaml
name: issue-runner

on:
  schedule:
    - cron: '0 * * * *'
  workflow_dispatch:

concurrency:
  group: issue-runner
  cancel-in-progress: false

permissions:
  contents: read
  issues: write
  pull-requests: write
  actions: read # dead-lock detection, and fetching failing CI logs
  checks: read # the check conclusions the loop decides from
  statuses: read # the same answer from integrations that use commit statuses

jobs:
  tick:
    runs-on: ubuntu-latest
    timeout-minutes: 90
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: yvz-dmr/issue-runner@v1
        with:
          model: sonnet
          claude-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          github-token: ${{ secrets.ISSUE_RUNNER_TOKEN }}
```

Two of its inputs deserve a word:

- **`github-token` is required and does not fall back to `github.token`.** Many repositories
  forbid Actions from opening pull requests outright, and one opened by `GITHUB_TOKEN` starts
  no workflows at all - so its checks would never run, and the loop would sit at `merging`
  waiting for a signal that cannot arrive. Give it a token belonging to a person or an app,
  and give the same token to `actions/checkout`, which is what leaves push credentials behind.
- **`claude-token`** is what `claude setup-token` prints. Leave it empty only if the step's
  environment already carries `ANTHROPIC_API_KEY`.

**Nothing has to be installed on the runner.** The action downloads the CLI itself, verifies
it against the SHA-256 in Anthropic's release manifest, and caches it per version in the
runner's tool cache - a first run costs the download, every run after it costs nothing. The
`version` input takes a channel (`stable`, the default, or `latest`) or an exact version to
pin.

**Node.js is installed the same way, for the same reason.** The CLI's own shell commands run
whatever the runner's image happened to ship with, and an image built only to execute Actions
- `myoung34/github-runner`, GitHub's own Windows service account - is not guaranteed to
expose a `node` at all. The `node-version` input (default `lts`, or `latest`, or an exact
version) is downloaded from nodejs.org, checksum-verified against its own `SHASUMS256.txt`,
cached per version, and put on PATH before the session starts - so a skill that shells out to
`node`, the way `run-tests` does, finds one whether or not the machine already had it. Node.js
ships no official musl build, so this fails fast with a clear message on an Alpine-based
runner image rather than downloading a binary that cannot run there.

That is worth doing rather than asking for a preinstalled binary, because a self-hosted
runner's service usually runs as an account nobody logs into: it sees only the machine PATH
and cannot read another user's home, so the ordinary per-user install is invisible to it. The
official installers are a shell script and a PowerShell script, neither of which an action
that refuses to assume a shell can use - but what they do is a version lookup, a manifest and
a download, and that is all this does.

The CLI runs as `claude --print`: one non-interactive turn, and no session after it. That
matters more than it sounds - a run that backgrounds a slow command (a test suite that builds
an image first, say) and ends its turn to "check back once it finishes" does not pause. The
turn ends, the process exits, and nothing is ever going to check back; whatever the command
was supposed to prove is simply never seen, and the issue parks at `status:blocked` with no
`next-status` written. `PROTOCOL.md` says this in the worker's own words, and
`--disallowed-tools ScheduleWakeup` closes half of it at the CLI level - there is no session
later for a scheduled wake-up to reach, so the tool has no legitimate use here. Backgrounding
a Bash command has no matching flag to disable, since it is a parameter of the Bash tool
rather than a tool of its own; the protocol's wording is what stands in for it.

### What it cost

Every run rewrites a single comment on the issue with what that issue has cost so far -
tokens in and out, cache written and read, and how many runs it took. One comment rather than
one per run, because an issue is normally worked more than once and a note showing only the
latest would quietly drop what the earlier attempts spent. The running total lives in the
comment's marker line, the same way the loop carries pull request state, so nothing has to be
stored anywhere else.

The token table and the dollar figure are **cumulative over the issue**; the last line is the
run that just finished. Its rate limit is reported as a span - `5-hour 41% → 80%` - so the
gap is what that one run consumed of the window. That is the one figure never accumulated:
the windows roll on their own schedule, so adding up what several runs each spent would
describe nothing real. The CLI reports the limit from its first response onwards, so `before`
is as of that response rather than the instant the run began - a turn's worth of difference on
a run that takes a hundred of them.

The dollar figure is the **list-price equivalent** and the note says so: it is what those
tokens would cost through the API, not a charge against a subscription. What a subscription
actually spends is that rate-limit span, which is why the two sit together. A failed run is
written up too - that is exactly the run whose cost you want to see - and
if the comment cannot be written the run is not failed over it, since losing a note must not
turn a finished pull request into `status:failed`.

Commits are authored as `issue-runner <issue-runner@users.noreply.github.com>`: a runner
account has no git identity of its own, and `git commit` refuses without one.

**If the runner itself runs as root** - some self-hosted container images do - the CLI refuses
its own `bypassPermissions` mode there and this step fails with `--dangerously-skip-permissions
cannot be used with root/sudo privileges`. That refusal exists because bypass mode already
removes the approval checkpoint, and root removes the last thing that would have contained a
mistake. The CLI's own escape hatch is `IS_SANDBOX=1`, for exactly the unattended-container
case this step already is; set it as `env:` on this step in the calling workflow, not
something this action decides for you - accepting that trade-off is a call each repository
should make for itself.

## The state machine

Every issue the runner cares about carries exactly one `status:` label. Issues with no
`status:` label are backlog and are invisible to it - labelling an issue `status:open` is
the explicit act that admits it into the queue. That doubles as the authorization boundary:
only someone who can label an issue can hand it to the worker.

| label               | meaning                                          | blocks the queue |
| ------------------- | ------------------------------------------------ | ---------------- |
| (none)              | backlog, not admitted                            | no               |
| `status:open`       | queued, the runner may pick it up                | no               |
| `status:processing` | claimed by a run, work in progress               | **yes**          |
| `status:merging`    | work done, a pull request awaits review/merge    | **yes**\*        |
| `status:blocked`    | needs a human decision                           | no               |
| `status:failed`     | last run failed, needs a human before requeueing | no               |
| `status:done`       | finished and merged (issue closed)               | no               |

\* `merging` blocks *other* issues, but the runner may pick that issue's own pull request
back up - see [Following an open pull request](#following-an-open-pull-request).

The labels are created on the first run; nothing has to be set up by hand.

## What one tick does

1. **Bootstrap** - create any missing `status:` label.
2. **Reap stale locks** - for each `status:processing` issue, read the workflow run id from
   its lock comment and ask GitHub whether that run is still alive. A lock held by a dead
   run is released. With no lock comment, the label's age is compared against
   `stale-lock-minutes` (default 120).
3. **Follow the pull requests** - for each `status:merging` issue, read the recorded pull
   request and decide what happens next. See below.
4. **Busy check** - if any open issue is still `status:processing` or `status:merging`, the
   tick reports `busy` and stops. **No worker runs.**
5. **Select** - otherwise take the lowest-numbered `status:open` issue (FIFO).
6. **Claim** - move it to `status:processing` and post a lock comment naming the run.

## Following an open pull request

An issue sits at `status:merging` from the moment a pull request exists until it is merged.
That holds the queue, deliberately - but "held" does not mean "asleep". Every tick the
runner asks GitHub what changed, and **the answer decides whether a worker starts**:

| what the pull request looks like          | what happens                             | worker |
| ----------------------------------------- | ---------------------------------------- | ------ |
| merged                                     | `status:done`, issue closed               | no     |
| closed without merging, or deleted         | `status:blocked`                          | no     |
| draft                                      | wait                                      | no     |
| checks still running                       | wait                                      | no     |
| checks green, nothing new said             | wait for a human to merge                 | no     |
| **checks red**                             | reclaim the issue, `task=fix-checks`      | yes    |
| **an unanswered human comment or review**  | reclaim the issue, `task=address-review`  | yes    |

Whether CI passed is read from check conclusions and commit statuses - never inferred by a
model. Comments authored by bots, and the runner's own marker comments, are filtered out, or
it would answer itself forever.

One thing catches people out, and it is GitHub's doing rather than the runner's: comments
added through **Start a review** stay a *draft* until **Submit review** is pressed. A draft
is visible to its author and to nobody else - not to other reviewers, and not to any API
token, so the runner cannot see it either. A pull request that looks thoroughly reviewed in
your own browser is an untouched one to every tick, which will keep reporting `0 unanswered
comment(s)` and keep waiting for a human to merge. Submit the review, or use the single
**Comment** button, and the next tick picks the comments up.

A follow-up claim reuses `status:processing` and the ordinary lock rather than adding a
state. One consequence is handled explicitly: when a lock is reclaimed, an issue that
already has an open pull request goes back to `status:merging`, not `status:open` -
requeueing it would hand the same work to a worker that knows nothing about the branch, and
a second pull request for one issue is the outcome nobody wants. The same applies to a
cancelled or failed run.

### What stops it looping

A worker that can push is a worker that can push forever, so three limits sit in the way:

- **One attempt per commit.** The marker records the head SHA the runner acted on. If that
  same commit is still red on the next tick, the fix did not work - or nothing was pushed -
  and the issue is parked at `status:blocked`.
- **A cap per pull request** (`max-fix-attempts`, default 3), so push-fail-push-fail cannot
  run all day even as the SHA keeps changing.
- **The watermark moves before the work, not after.** The claim posts the updated marker
  first, so a run that dies cannot make the next tick answer the same comment twice or spend
  the same attempt again.

Human comments are deliberately *not* capped. There is a person in that loop already, and
rate-limiting a reviewer would be the wrong thing to protect against.

The marker comment is where all of this lives:

```
<!-- issue-runner:pr number=42 sha=abc1234 attempt=2 seen=2026-09-18T12:00:00.000Z -->
```

Only the marker line is parsed, so prose underneath it - including anything a person or an
issue body quotes - cannot forge a field.

## The worker contract

Claude runs only once an issue is claimed. Everything it is given sits in one directory, the
`state-dir` output (default `$RUNNER_TEMP/issue-runner`):

| file            | what it is                                                                   |
| --------------- | ---------------------------------------------------------------------------- |
| `PROTOCOL.md`   | how to work the issue: the procedure, copied out of the action                |
| `task`          | `implement`, `fix-checks` or `address-review` - the protocol branches on it   |
| `issue.json`    | the claimed issue                                                             |
| `pr.json`       | follow-ups only: number, state, draft, head SHA and branch                    |
| `checks.json`   | follow-ups only: the checks that failed, with their conclusions               |
| `checks.log`    | follow-ups only: the tail of those jobs' logs, bounded                        |
| `comments.json` | follow-ups only: unanswered human comments and reviews                        |

The issue arrives as a file and never as a shell argument, because a title or a body is
input anyone with write access can author.

Before finishing, the worker writes its outcome into that same directory:

| file          | value                                              |
| ------------- | -------------------------------------------------- |
| `next-status` | `open` / `merging` / `blocked` / `done` / `failed` |
| `pr`          | pull request number, with `next-status=merging`     |

Once Claude exits, the same run maps what happened onto a label - there is no separate
release step to guard with `if: always()`, since claiming, working and releasing all happen
in the one action:

- Claude's process failed to start or exited non-zero -> `status:failed`, or
  `status:merging` when a pull request is already open
- it exited cleanly -> whatever `next-status` says
- it exited cleanly but wrote no `next-status` -> `status:blocked`, on purpose, so a
  misbehaving worker parks the queue instead of spinning on the same issue every hour

A run that is cancelled or killed outright gets no chance to release anything, so the issue
stays at `status:processing`. That is not a stuck state: the next tick's stale-lock check
(see [What one tick does](#what-one-tick-does)) asks GitHub whether that run is still alive,
finds it is not, and releases the lock itself.

### The protocol, and what it deliberately leaves out

`PROTOCOL.md` is the procedure Claude follows. It carries only what is true in **any**
repository: the contract above, the rule that an issue body is data rather than instruction,
when to stop and write `blocked`, branch and pull request conventions, and the policy that a
worker runs the narrowest test slice and never the whole suite.

It carries nothing repository-specific, and that is what makes it portable. Where the work
needs a local answer it defers to the consuming repository's own agent docs - `AGENTS.md` or
`CLAUDE.md`, which Claude loads anyway. Those are where a project states its engineering
principles, its language rule, and **how to run a narrow slice of its tests**. Adopting the
runner means writing those, not editing the protocol.

The protocol travels through the state directory rather than through a path in the
workspace, because once this action is consumed by `uses:` its files are not anywhere the
calling workflow could name. So the prompt handed to Claude is the same line everywhere:

```
Read $STATE_DIR/PROTOCOL.md and follow it. The claimed issue is $STATE_DIR/issue.json.
```

## Inputs

| input                | default          | effect                                                   |
| --------------------- | ---------------- | -------------------------------------------------------- |
| `token`               | `github.token`   | needs `issues: write`, `checks: read`, `actions: read`   |
| `label-prefix`        | `status:`        | prefix for the state labels                               |
| `stale-lock-minutes`  | `120`            | how long a lock with no identifiable run may be held       |
| `max-fix-attempts`    | `3`              | red-CI fix attempts per pull request before parking it     |
| `follow-reviews`      | `true`           | set `false` to stop treating human comments as work        |
| `dry-run`             | `false`          | decide and report, write nothing back to GitHub            |
| `force-issue`         | -                | take this issue instead of the next queued one             |
| `state-dir`           | `$RUNNER_TEMP/…` | the directory the worker exchanges files through            |
| `model`               | `sonnet`         | which Claude model works the issue                          |
| `version`             | `stable`         | which Claude Code CLI to run: a channel or an exact version |
| `node-version`        | `lts`            | which Node.js to put on PATH for the CLI's own commands     |
| `claude-token`        | -                | from `claude setup-token`; leave empty to use `ANTHROPIC_API_KEY` |
| `github-token`        | -                | **required**; pushes and opens the pull request             |

## Outputs

| output      | value                                                        |
| ----------- | ------------------------------------------------------------ |
| `decision`  | `busy` \| `idle` \| `claimed`                                 |
| `issue`     | the claimed issue number, empty unless `claimed`              |
| `title`     | the claimed issue title                                       |
| `task`      | `implement` \| `fix-checks` \| `address-review`               |
| `pull`      | the pull request being worked on, empty for a fresh issue     |
| `state-dir` | the directory the worker reads from and writes back to        |

## Working on the action

```sh
npm ci
npm run all          # typecheck + tests + bundle
```

There is one action here, `action.yml`, entry point `src/main.ts`, bundled to `dist/index.js`
- and **the bundle must be committed**, since the runner executes it directly and never
installs dependencies. Rebuild in the same commit as any source change.

The stock Node `.gitignore` excludes `dist` - the un-ignore at the bottom of `.gitignore` is
what keeps that working, so do not remove it.

`PROTOCOL.md` is read from disk at run time rather than bundled, so editing it needs no
rebuild. It does have to travel with `dist/`, which is why the loop resolves it relative to
itself and fails the claim outright if it is missing: an action that locked an issue and then
handed Claude no procedure would strand that issue.

The engine's decision logic is pure and covered by `src/engine.test.ts` against a fake
gateway - add a case there before changing how the queue behaves. `src/worker.test.ts` covers
what the state directory ends up containing. `src/transcript.test.ts` and `src/install.test.ts`
cover the Claude worker's two halves - reading the CLI's stream, and choosing what to
download - which is why both live outside `src/claude.ts`, whose `runWorker` is what
`src/main.ts` calls once an issue is claimed.

## Releasing

There is no version ladder. Consumers pin `@v1`, and `v1.0.0` exists only because some tools
expect a dotted version - both tags always point at the same commit, the tip of `main`. A
workflow (`.github/workflows/retag.yml`) force-moves both tags to whatever lands on `main` on
every push to it, regardless of what pushed it - the CLI, GitHub Desktop, anything else with
write access. There is nothing to run by hand.
