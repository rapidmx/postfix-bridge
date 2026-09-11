# Code review notes — rapidrest/mail-server

This file exists so that Claude sessions working in this repo don't re-litigate settled
decisions or re-discover the same issues from scratch. It is local to this repo (not tied to
any one machine's global Claude memory), so it travels with the code.

**Maintenance rule:** when a standing decision changes, update the section below in place
(don't just append a contradiction lower down). When a new investigation/session produces a
decision, finding, or reverted approach worth remembering, add a dated entry under Session Log.
Keep entries terse — this is a reference, not a transcript.

## Standing decisions

- **Commit discipline.** Don't `git commit` unless explicitly asked for *that specific piece of
  work*. An autonomous-execution/"commit as you go" approval given for one approved plan (e.g. via
  plan mode) is scoped to that plan only — it does not carry forward to later, separate requests in
  the same session, even ones that look similar in kind (a follow-up review-and-fix pass, a
  refactor, a new feature), and even after a full review-and-fix cycle with passing tests. Default
  to leaving changes staged/unstaged and saying so; only commit automatically within the exact
  scope of a plan that was explicitly approved as autonomous. If unsure whether new work falls
  inside that scope, treat it as outside and ask.
- **Commit message style: a flat list of one-line, verb-led items — no summary/title line, no
  `-`/`*` bullet markers.** This isn't just a style preference — it's dictated by how `release`
  (`@rapidrest/cli`) actually builds `CHANGELOG.md`. `collectChangelogBullets`/
  `classifyChangelogLine` (that repo's `src/lib/release.ts`) parse `git log --pretty=format:%B` and
  treat **every non-blank line of a commit's full message as its own changelog bullet** — there is
  no subject/body distinction. A conventional "short imperative subject + blank line + prose body"
  commit therefore leaks one changelog bullet per body sentence, and a `-`/`*`-prefixed line breaks
  `classifyChangelogLine`'s verb detection (it reads the line's first whitespace-delimited word as
  the verb; a leading `-` defeats that lookup and the dash leaks into the changelog text as
  `"- - Added foo"`). Correct format:
  - No separate summary/title line — if a commit needs an overview, that overview is itself just
    one more flat line, not a heading distinct from the rest.
  - No bullet-marker prefix of any kind — write bare lines.
  - Lead each line with an imperative verb where it fits: `Add`/`Fix`/`Remove` (and `-ing` forms)
    are recognized and become `Added`/`Fixed`/`Removed` entries; `Configuring`/`Converting`/
    `Refactoring`/`Updating`/etc. become `Changed`. Anything else still works, defaulting to
    `Changed` verbatim — see `CHANGELOG_VERB_REWRITES` in that repo's `src/lib/release.ts` for the
    full map.
  - A blank line before a trailing git trailer (`Co-Authored-By:`, `Signed-off-by:`, etc.) is fine
    — trailers matching `CHANGELOG_NOISE_PATTERNS` are dropped from the changelog — but nothing
    else should follow the item list.
  This mirrors JP's standing convention across his other repos; copy this exact rule verbatim into
  each sibling repo's own NOTES.md rather than paraphrasing it, since the paraphrase is what caused
  this to be gotten wrong in the first place (see `@rapidrest/cli`'s own NOTES.md, 2026-09-07 entry,
  for the full incident writeup and the `CHANGELOG_NOISE_PATTERNS` fix that accompanied it).
- **Never bump a `package.json` `version` field, in this repo or any sibling `@rapidrest/*` repo,
  and never publish/`npm publish` one.** JP has a formal release process for that (see e.g.
  `mail-server`'s own `"version"`/`"postversion"` npm-lifecycle scripts, which sync the Helm
  chart/README and push tags — a manual version edit bypasses all of that and produces conflicts).
  This applies even when a fix in a sibling repo is otherwise done and verified: land the source
  fix, leave the version field alone, and tell JP it's ready for him to version/publish himself.
  Once he publishes, bump *this* repo's dependency constraint (e.g. `"@rapidrest/auth": "^X.Y.Z"`)
  to the version he actually published — that part is fine, since it's just declaring what this
  repo needs, not deciding a sibling repo's own release number.

## Session Log

### 2026-09-11 — 100% coverage, real CONTRIBUTING.md

`src/index.ts` (the actual startup wiring - env parsing, which lookup goes to which server,
listen/shutdown sequencing) had 0% coverage; the other three files (`MtaIngestClient.ts`,
`SmtpDeliveryServer.ts`, `TcpTableServer.ts`) already had real-socket tests but a handful of
uncovered branches. Brought the whole package to 100% statements/branches/functions/lines and
pinned that via a new `thresholds` block in `vitest.config.ts` (there wasn't one before).

- **`test/index.test.ts` mocks all three collaborator classes** (`MtaIngestClient`,
  `TcpTableServer`, `SmtpDeliveryServer`) rather than opening real sockets/HTTP - those classes
  already have their own real-I/O tests; this file's only job is the wiring itself (env var
  parsing/defaults, which lookup callback goes to which server, startup failure → `process.exit(1)`,
  SIGINT/SIGTERM → close-everything → `process.exit(0)`). Same `vi.resetModules()` + fresh
  `import()` per test pattern as `electron-client`'s `src/main/index.ts` tests, since this file
  also throws synchronously at import time (`requireEnv("MTA_INGEST_SECRET")`) and has import-time
  side effects (`process.on(...)`, `void start().catch(...)`).
  - `process.on`/`console.log`/`console.error`/`process.exit` are all spied on, and
    `process.removeAllListeners("SIGINT"/"SIGTERM")` runs in `afterEach` - otherwise every test's
    fresh `import()` re-registers two more real listeners on the actual `process` object for the
    life of the test file.
- **A few branch/function gaps needed the class's own private methods invoked directly** rather
  than driven through real socket/SMTP I/O, where the real trigger condition is impractical to
  force deterministically over a real socket:
  - `TcpTableServer.handleLine()`'s `if (socket.destroyed) return` guard - tested by calling
    `handleLine` directly with a fake `{ destroyed: true }` socket.
  - `TcpTableServer`'s `socket.on("error", () => {})` handler - tested by adding a second
    `"connection"` listener on the real underlying `net.Server` (harmless alongside
    `net.createServer`'s own callback-as-listener) that synthetically emits `socket.emit("error",
    ...)` on the real accepted socket, rather than racing a genuine abrupt disconnect.
  - `SmtpDeliveryServer.handleData()`'s null-reverse-path branch (`session.envelope.mailFrom ?
    ... : ""`) and its `stream.on("error", ...)` handler - tested by calling the private
    `handleData()` directly with a fake `EventEmitter` stream and a hand-built `session` object,
    since nodemailer's own wire behavior for `MAIL FROM:<>` isn't something worth depending on to
    hit this branch reliably.
  - `TcpTableServer.close()`'s reject branch - `vi.spyOn` the real underlying `net.Server`'s own
    `close()` with `mockImplementationOnce` to inject one synthetic error, leaving the real
    `afterEach` cleanup close() unaffected.
- Fixed `CONTRIBUTING.md`'s bug-report/feature-request examples, which were the generic
  RapidMX template's `@rapidrest`/admin-console-flavored ones (copy-pasted from `server`/`restapi`,
  not this bridge) - replaced with a `tcp_table`/Postfix-relevant example and Project Info fields
  (bridge version, RapidMX server version, Postfix version).
- Not committed - JP said "hold off on commit" for this whole cross-repo pass.
