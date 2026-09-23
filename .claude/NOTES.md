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

## 2026-09-15 — Helm chart fixes for the RapidMX server's bundled `postfixBridge` dependency (uncommitted, needs a 1.1.0 release)

The server chart (`../server`) now bundles this chart (alias `postfixBridge`, pinned to 1.1.0) and sets `ingestSecret`, `ingestBaseUrl`, `hostname`, `domains`, `dkim.storage.existingClaim` (its own `<release>-dkim-keys`) and `tls.certManager.enabled`.

**postfix-bridge chart**
- `postfixBridge.storageClassName` helper renders the class before comparing: "default"/empty omit `storageClassName`
  (both PVCs). Previously always `storageClassName: "default"`.
- `dkim.storage.existingClaim` (tpl'd): mount that claim and don't create the chart's `-dkim-keys` PVC.
- `tls.existingSecret` (tpl'd) and `tls.certManager.{enabled,issuerName,issuerKind}`. A Certificate only for a public
  hostname with cert-manager enabled; otherwise a self-signed Secret (10 years) reused via `lookup` while its
  `postfix-bridge.rapidmx.dev/self-signed-for` annotation matches the hostname (regenerated on a hostname change or when
  replacing a cert-manager-written Secret). Previously regenerated on every upgrade.
- `hostname`, `domains` (and NOTES) tpl'd. `ingestSecret` default `''` with `required` (so `helm lint` passes) and the
  `ChangeMeIngestSecret` placeholder refused.
- NOTES.txt/README use the real value names (`ingestSecret`, not `mail.ingestSecret`) and describe the standalone setup.
- Not changed: `boky/postfix:latest` image tag; literal `postfix`/`postfix-bridge` Deployment/Service names; nothing
  stamps Authentication-Results (so no authserv-id for the server's `mail.trustedAuthservId`). CHANGELOG is generated
  from commits, left alone.

Verified: `helm lint`; `helm template` defaults, public hostname, cert-manager off, existingSecret with templated
values from a values file, empty/placeholder secret failures, certificate reuse with `lookup` stubbed; rendered as a
subchart of the server chart for both installer TLS modes.

## 2026-09-15 — values.yaml comments restored after the release tool stripped them

The `@rapidrest/cli` release command dropped every values.yaml comment (js-yaml load/dump); fixed in
`D:/github/RapidREST/cli` (uncommitted, needs a cli release before the next release here). Restored in the working tree,
not committed:
- helm/values.yaml: 5e3baf6's file with the tag set to 1.1.0 (the 1.1.0 release commit changed nothing else there);
  js-yaml data identical, helm lint clean.

## 2026-09-15 - ingestSecretRef, for a secret something else owns

The RapidMX server chart now keeps its secrets in OpenBao, so there is no literal ingest secret to hand this chart.
`ingestSecretRef` (name + key, tpl'd) points the bridge at an existing Secret - the server's own
<release>-mail-ingest-secret, which External Secrets fills from the vault - and this chart then renders no Secret of its
own and doesn't require ingestSecret. Needs a 1.2.0 release: the server chart pins that version and fails the render
with a version check when an older copy is bundled.

## 2026-09-19 - Postfix as an MX and the cluster's relay: the chart was an open relay and could neither send nor receive

Found by running the chart (via the server chart's `postfixBridge` dependency) on a real k3s host with port 25 exposed.
Changes are in `helm/` (uncommitted; needs a release after 1.2.0 - the server chart bundles a locally patched 1.2.0 until then).

- **Open relay:** k3s ServiceLB with `externalTrafficPolicy: Cluster` shows every internet client as `10.42.0.1`; boky/postfix
  trusts `mynetworks` 10/8, 172.16/12, 192.168/16 and sets `smtpd_relay_restrictions=permit`, so from outside
  `MAIL FROM:<x@allowed-domain>` `RCPT TO:<anyone>` was accepted. Reproduced from the internet (refused only by the target's null
  MX) and confirmed the cause with a throwaway socat LoadBalancer: Cluster -> 10.42.0.1, Local -> the real address. The
  `postfix` Service now sets `externalTrafficPolicy: Local` (`postfix.externalTrafficPolicy`).
- **Could not receive:** the image's send-only defaults reject any client outside mynetworks and any sender outside
  ALLOWED_SENDER_DOMAINS. **Could not send:** `smtpd_tls_security_level=encrypt` refused the server's plaintext msmtp hop
  (`530 Must issue a STARTTLS command first`), contradicting this file's own "plaintext internal hop" comments.
- **New policy (all `POSTFIX_*` env, boky applies them after its defaults):** `smtpd_tls_security_level=may`;
  `smtpd_client_restrictions = permit_mynetworks, reject_plaintext_session` (outsiders need TLS); `smtpd_relay_restrictions =
  permit_mynetworks, reject_unauth_destination`; a restriction class `internal_sender_check` (`check_sender_access
  lmdb:/etc/postfix/allowed_senders, reject`, the map boky builds from ALLOWED_SENDER_DOMAINS) reached through
  `check_client_access cidr:/etc/postfix/internal_clients` (a new key in the mail-tls-policy ConfigMap, generated from
  `postfix.internalNetworks`); recipients otherwise go through `reject_unauth_destination`, i.e. relay_domains only.
- **Verified from the internet and from the server pod:** outsider -> outside domain `Relay access denied` (spoofed allowed
  sender too); plaintext outsider `450 Session encryption is required`; in-cluster plaintext as an allowed sender 250, as
  another domain refused. A message handed to the bridge's :2525 listener reached the server's ingest queue and a mailbox.
- **Not done:** docker-compose.yml still has the old settings (docker keeps client addresses, so not an open relay, but the same
  send/receive problems); no chart test harness exists here, verification was `helm template`/`lint` plus the live cluster.
- **If a load balancer other than k3s' ServiceLB is used,** check which address Postfix logs for an outside connection before
  opening port 25 - anything inside `internalNetworks` is trusted to relay.

### 2026-09-19 (later) - DKIM key mismatch and Postfix's DNS client, found by sending real mail

- **DKIM never verified.** The image's DKIM backend is OpenDKIM (`/scripts/functions.sh` `postfix_setup_dkim`), not rspamd as the chart
  comments said: it reads `/etc/opendkim/keys/<domain>.private` (flat, not `<domain>/<selector>.private`), and with DKIM_AUTOGENERATE it
  generates that file when missing and then never overwrites it. So it signed with its own key while DNS carried the server's
  (`/var/lib/rspamd/dkim/<domain>.<selector>.key`, what the DNS-setup page shows). Confirmed by fingerprint (`openssl rsa -pubout`) and by
  dkimpy failing against DNS with a matching body hash. Fixed with a `dkim-keys-sync` init container that installs the server's key at
  the image's path (the image then keeps it); dkimpy now verifies a delivered message against the published record. A domain added
  later needs a Postfix restart, as ALLOWED_SENDER_DOMAINS already does.
- **`ALLOWED_SENDER_DOMAINS` is split on whitespace** by the image; the chart's comma-separated `domains` made several domains one bogus
  entry. Now converted.
- **Postfix's DNS client ignores the pod's search domains,** so the bare `postfix-bridge` in transport_maps (since replaced by relay_transport, see 2026-09-20 "external recipients") bounced every accepted message
  (`Name service error for name=postfix-bridge type=AAAA: Host not found`) although `postmap tcp:postfix-bridge:...` (system resolver)
  worked. `smtp_host_lookup = dns, native` fixes it; the bounce DSN went to the test sender (example.org, null MX), so nothing left the host.

### 2026-09-20 - OpenDKIM never verified, and signed for everyone (found chasing the server's "mail.trustedAuthservId is empty")

Both are in the boky/postfix image's OpenDKIM setup and were reproduced in a local docker lab, then confirmed on a real k3s host. Fix: `opendkim.sh` in the
mail-tls-policy ConfigMap, mounted at `/docker-init.d/opendkim.sh` (the image runs `*.sh` there with bash, after writing OpenDKIM's config and before it starts).
- **No key lookup ever worked:** libunbound in this image fails through the container resolver with `unexpected reply class/type (-1/-1)` (also against real
  public DNS in a plain container, and with an empty config). `Nameservers <ip>` fixes it (`opendkim-testkey`: key OK / record not found). Set from the pod's
  own `/etc/resolv.conf`. Verification then produced `Authentication-Results: <myhostname>; dkim=pass|fail ...`; a forged header claiming that authserv-id is stripped.
- **Everyone was "internal":** TrustedHosts is `0.0.0.0/0` and InternalHosts/ExternalIgnoreList are `refile:` (regex) on it, matching nothing, so OpenDKIM signed anything
  that matched the SigningTable - including an unsigned message from the internet with a forged From. InternalHosts is now `$POSTFIX_mynetworks`
  (comma CIDR list, valid OpenDKIM syntax; the image's own `OPENDKIM_*` env hook can't carry it: it edits the file with sed using `/` as the delimiter).
- Lab notes: `.test`/`.example` names are special-use in unbound and never reach DNS; dnsmasq's replies also failed until swapped for unbound. Not done: SPF/DMARC
  verification (OpenDKIM only does DKIM), no compose change.

### 2026-09-20 - domains added in the admin console need no restart, redeploy or helm upgrade

Before: the sender allow-list (ALLOWED_SENDER_DOMAINS) and OpenDKIM's key/signing tables were built once at start, so a new domain could not send, and
the first domain signed with a key nobody had published, until Postfix was restarted (and its domain added to `domains`). Now both follow the main service.
Built and proven in a docker lab that runs the chart's own rendered env/ConfigMap files with the *published* bridge image, a fake server API whose domain list
changes live, and unbound holding the test DKIM keys (14/14 checks), then on a real k3s host (key in OpenDKIM 8 s after `POST /api/mail/domains`, no pod restart).
- **Sender check:** `internal_sender_check` = static allowed_senders, then `check_sender_access pipemap:{regexp:sender_domain, tcp:postfix-bridge:10040, regexp:any_ok}`.
  The three stages: user@domain -> domain, the bridge's existing domain lookup (200 with the domain when the main service serves it), any hit -> OK.
  Gotchas found the hard way: a chain containing a pattern table (`regexp:`) makes Postfix do ONE lookup with the whole address and never the bare domain
  (`postconf`/debug_peer_list showed "skipping ... lookup for" the partial keys), which is why the domain has to be extracted inside the chain; and
  `postmap -q` does not reproduce smtpd's key handling, only smtpd with `debug_peer_list` does. Needs no bridge change or new image.
- **DKIM:** `dkim-sync.sh` (ConfigMap, mounted at /opt/postfix-bridge, started by appending a `[program:dkim-sync]` to /etc/supervisord.conf from the init script so
  supervisord restarts it) polls /var/lib/rspamd/dkim every 10 s, installs any *valid* new/changed key (`openssl pkey` guard: a half-written or empty file is skipped -
  the lab caught a test that "rotated" a key to an empty file and OpenDKIM correctly kept the old one), rebuilds KeyTable/SigningTable from /etc/opendkim/keys/*.private
  and sends SIGUSR1 ("configuration reloaded"); SIGUSR1 also makes OpenDKIM re-read a replaced key file (rotation verified).
- **Behaviour to know:** the server is the one sending, so with it down no outbound recipient can be classified (relay_domains lookup fails) and every send gets a
  temporary 451 - deferred, retryable, never lost; the static list does not help there. A domain becomes sendable when the main service reports it enabled AND verified
  (a new domain's key exists first, so a first message is signed unless verification lands inside the sync interval). Reserved TLDs (.invalid, .local, ...) are auto-verified
  by the server by design. Subdomain senders of a dynamic domain are not allowed (only the exact domain); the static list still matches parents.
- **Not done:** no compose change (compose keeps the old static behaviour); on the real host the delivery leg of the signing test could not be run with a throwaway domain
  (Postfix's reject_unknown_recipient_domain needs the recipient domain in public DNS, and a real domain needs real DNS verification) - do it when a real domain is registered.
- **Lab pitfalls:** writing a file for a bind mount on Docker-for-Windows via truncate+write can be seen empty in the container; Windows-written files get CRLF (a CRLF `resolv.conf`
  silently disables glibc's nameserver line); Git Bash rewrites `/path` docker args; unbound treats `.test`/`.example` as special-use.

### 2026-09-20 - external recipients were handed to postfix-bridge, not delivered: `transport_maps = static:` matches everything

**Symptom (live k3s host):** every message the RapidMX server sent to an external address (a reply to jean-philippe@steinmetz12.com) vanished. Postfix logged
`postfix/smtp: 30F4E100E98: to=<jean-philippe@steinmetz12.com>, relay=postfix-bridge[10.43.139.208]:2525, dsn=2.0.0, status=sent (250 OK: message queued)` and the
server's ingest then logged `MailIngestRoute: dropping delivery for unresolvable recipient ...`. `postmap -q steinmetz12.com tcp:postfix-bridge:10040` was correctly
"no match", so relay_domains itself was right.
- **Root cause:** `POSTFIX_transport_maps = static:smtp:postfix-bridge:2525` (postfix.yaml and docker-compose.yml). A `static:` table answers for every key, and
  transport_maps is consulted before the relay_domains/default_transport split, so every recipient - external ones included - was routed to the bridge's :2525. The
  bridge cannot tell "external, please deliver" from "mine" (it only ever POSTs to /internal/mta/deliver), so it 250'd and the server dropped it.
- **Why it wasn't caught:** outbound was only ever tested to a LOCAL (relay_domains) domain, where the wrong and the right route are the same; the 2026-09-19 lab
  bounced-mail evidence went to a null-MX example.org sender so nothing left the box either. `status=sent` to `postfix-bridge` looks like success in the log.
- **Fix:** `POSTFIX_relay_transport = smtp:postfix-bridge:2525` and no transport_maps (chart and compose). Stock Postfix: `relay_transport` (default `relay`, no next hop, so
  it would MX-look-up the domain itself) is the transport for relay_domains destinations, and only those; a next hop in it overrides the recipient domain. Everything
  else uses default_transport (`smtp`, MX lookup). It composes with the rest: `smtp_host_lookup = dns, native` resolves the bare `postfix-bridge` for both, and
  smtp_tls_policy_maps is keyed by the transport's next hop as written (`postfix-bridge:2525`, no brackets - a bracketed `[postfix-bridge]:2525` would need a matching key),
  so the existing tls_policy.txt carve-out still applies. Not chosen: `relay:postfix-bridge:2525` (same smtp client, logs as postfix/relay, which would make bridge hand-offs
  distinguishable from MX deliveries in the log - a fair follow-up, and the tls_policy key is the same).
- **Lab proof** (docker: boky/postfix:latest run on the chart's own rendered env + ConfigMap files, unbound serving `.lab`, the REAL bridge from `dist/` with a fake
  /internal/mta API and a capturing proxy in front of its :2525, three node smtp-server sinks as MXes: accept, 550-at-RCPT, 450-at-RCPT; the submitter is a container in
  172.16/12 = internal). BEFORE: `to=<jp@ext.lab>, relay=postfix-bridge[172.28.0.11]:2525, dsn=2.0.0, status=sent` and the ext.lab MX saw nothing (bug reproduced).
  AFTER: (a) `to=<bob@owned.lab>, relay=postfix-bridge[..]:2525 status=sent` and the API got `X-Envelope-From="alice@owned.lab" X-Envelope-To="bob@owned.lab"`;
  (b) `to=<jp@ext.lab>, relay=mx.ext.lab[172.28.0.31]:25 status=sent`, sink saw MAIL FROM:<alice@owned.lab> over STARTTLS, bridge saw nothing;
  (c) `to=<nobody@refuse.lab>, relay=mx.refuse.lab[..]:25, dsn=5.1.1, status=bounced (host mx.refuse.lab[172.28.0.32] said: 550 5.1.1 <nobody@refuse.lab>: Recipient
  address rejected: User unknown in virtual mailbox table (in reply to RCPT TO command))`; a 450-at-RCPT MX defers (dsn=4.2.0) and, with a short maximal_queue_lifetime, expires
  into a bounce (Action: failed, Status 4.2.0), with delay_warning_time an `Action: delayed` notice first (Postfix's default delay_warning_time is 0h: off);
  (d) `qmgr: 54630198272: from=<>, size=3273, nrcpt=1` then `smtp: 54630198272: to=<alice@owned.lab>, relay=postfix-bridge[..]:2525, status=sent` - the DSN goes through
  relay_transport to the bridge, and the API got `X-Envelope-From=""  X-Envelope-To="alice@owned.lab"`. A message to `bob@owned.lab, jp@ext.lab` is split correctly.
- **The DSN a user gets** (and what the server's ingest must handle): MAIL FROM:<> (wire: `MAIL FROM:<> BODY=8BITMIME`), RCPT TO the original sender, `From: Mail Delivery System
  <MAILER-DAEMON@<myhostname>>`, `Subject: Undelivered Mail Returned to Sender`, `Auto-Submitted: auto-replied`, multipart/report; report-type=delivery-status with the
  human text (`<nobody@refuse.lab>: host mx.refuse.lab[172.28.0.32] said: 550 5.1.1 ...`), a message/delivery-status part (`Action: failed`, `Status: 5.1.1`,
  `Diagnostic-Code: smtp; 550 5.1.1 ...`, `Final-Recipient`, `Original-Recipient`) and the original message as message/rfc822. It has no Return-Path and no DKIM signature
  (Postfix generates it locally; nothing authenticates it), and `myhostname` is the From domain, which need not be a domain the server serves. Captured byte for byte
  (what the bridge POSTs to /internal/mta/deliver) in `test/fixtures/dsn-unknown-recipient-550.eml`, `dsn-expired-450.eml`, `dsn-delayed-450.eml`, with the envelope in
  `dsn-envelope.json` and the SMTP conversation in `dsn-unknown-recipient-550.smtp-session.txt`. `.gitattributes` marks `test/fixtures/*.eml -text` (CRLF must survive).
- **Null sender through the bridge:** smtp-server accepts `MAIL FROM:<>` (`session.envelope.mailFrom === false`), `SmtpDeliveryServer` forwards `envelopeFrom = ""`, and
  `MtaIngestClient.deliver` sends `X-Envelope-From: ` with an EMPTY value (real fetch to a real http server confirmed in a test and in the lab; the header is present, not
  omitted). The earlier test only drove `handleData()` with a fake session; there are now wire-level tests with the fixtures, and one for the HTTP header. The server side
  must treat the empty header as "null sender" (do not require it to be non-empty, and do not fall back to From:).
- **Tests:** `test/routing.test.ts` reads postfix.yaml/docker-compose.yml/tls policy as text (no `POSTFIX_transport_maps`, relay_transport is `smtp:postfix-bridge:2525`, TLS
  carve-out under the same key); it fails on the old config. Routing itself can only be proven against a real Postfix (the lab). `tsc -p tsconfig.test.json` has a pre-existing
  error in TcpTableServer.ts (`temporary`), unrelated; `yarn tsc --noEmit` (the real config) is clean.
- **Not done:** the compose stack itself wasn't run (its config validates with `docker compose config`; the same env change was proven in the lab); nothing changed in the server
  repo. The Postfix pod's queue is not persistent (no volume), so flush it (`postqueue -f`) before the rollout restarts the pod.
- **Lab pitfalls again:** Git Bash `$'\r'` inside `$( )` breaks the shell parse; use `MSYS_NO_PATHCONV=1` for every docker mount; unbound needs `local-zone: "lab." static` plus explicit
  local-data; Docker's embedded DNS (127.0.0.11) answers the bare `postfix-bridge` for Postfix's own resolver too, so the search-domain bug from 2026-09-19 does NOT reproduce
  in plain docker (it needs a cluster).

### 2026-09-22 - adversarial review: recipient-header ambiguity, unbounded message buffering, no upstream timeout, `close()` can hang forever

An adversarial review (including live reproductions against `smtp-server`'s own internals) found five issues, all fixed here; a sixth (docker-compose.yml's DKIM setup being stale) was doc-only.

- **`X-Envelope-To: envelopeTo.join(",")` was ambiguous.** `smtp-server` does only "permissive validation" on `RCPT TO` - a quoted local part containing a literal comma (RFC 5321 allows it, e.g. `RCPT TO:<"a,b"@example.com>`) is accepted unchanged (confirmed by reading `_parseAddressCommand()`'s `ADDRESS_UNSAFE_CHARS` regex, which comma isn't in). Joining recipients with a bare `,` could then make one recipient split into two on the receiving end. Fixed by percent-encoding every envelope address (`encodeEnvelopeAddress()`, `MtaIngestClient.ts`) before it goes into a header, using `encodeURIComponent` (already used in this same file for `checkDomain()`/`resolveRecipient()`'s query strings) rather than reusing `TcpTableServer`'s own `encodeTcpTableValue` - that helper encodes by UTF-16 code unit (`charCodeAt`), correct for `tcp_table(5)`'s byte-oriented wire format but wrong for a multi-byte UTF-8 character here (it would emit one `%XX` for a 2+ byte character). This also closes the RFC 6531 (SMTPUTF8) non-ASCII-local-part mangling issue as a side effect.
  - **Not done, flagged in code comments and RELEASE_NOTES.md: `@rapidmx/restapi`'s `BaseMailIngestRoute.deliver()` still does a naive `envelopeToHeader.split(",").map(a => a.trim())` with no `decodeURIComponent`.** That's a different repo, out of scope for this task's authorization. The fix here guarantees the *count* of recipients survives (no extra, garbled recipient is synthesized by a stray comma) - the security-relevant half - but full address fidelity for an address that actually needed encoding needs that repo's own follow-up decode. Every test here treats "does a naive comma-split give back the right *count* of segments, and does `decodeURIComponent` on each recover the original" as the round-trip contract, not "does today's restapi already handle this."
- **No message-size cap.** `SmtpDeliveryServer`'s `handleData()` pushed every `data` chunk onto an unbounded array. `smtp-server`'s own `size` option (its README: "Using the SIZE extension") only checks a client-declared `MAIL FROM ... SIZE=nnn` up front - it does **not** enforce the limit against the actual transfer; the app has to check `stream.sizeExceeded` itself. Now wired: `size` is passed to the `SMTPServer` (configurable via `MTA_BRIDGE_MAX_MESSAGE_SIZE`, default 25 MiB), and the `data` handler stops pushing chunks the moment `stream.sizeExceeded` flips true, with `end` rejecting via a permanent `552` rather than the existing `450` retry path (retrying won't shrink the message).
- **No timeout on any of the three `fetch()` calls in `MtaIngestClient.ts`.** `TcpTableServer` serializes lookups per Postfix-held connection (its own doc comment), so one hung upstream call stalled every queued lookup on that connection forever; a hung `deliver()` call did the same to the one in-flight SMTP transaction. Fixed with `signal: AbortSignal.timeout(this.timeoutMs)` (configurable via `MTA_INGEST_TIMEOUT_MS`, default 10s) on all three calls - deliberately **not** caught/mapped inside `MtaIngestClient` itself: the resulting `TimeoutError` rejection propagates like any other network failure straight into the 400/450 "temporary, retry later" mapping `TcpTableServer.handleLine()`/`SmtpDeliveryServer.handleData()` already had, so no new error-translation code was needed. Verified against a real `http.createServer` that accepts the connection but never responds (a mocked `fetch` can't show whether a real stalled request actually gets cut off).
- **`TcpTableServer.close()` could hang forever.** A plain `net.Server.close()`'s callback doesn't fire until every connection has ended, and Postfix's `tcp_table(5)` client is documented to reuse one connection for many sequential lookups - a live one at shutdown time hung `close()`, which hung `index.ts`'s `shutdown()`, which never reached `process.exit(0)` (Kubernetes then SIGKILLs after `terminationGracePeriodSeconds`). `http.Server.closeAllConnections()` (what the task write-up suggested first) turned out **not to exist on `net.Server`** - only on `http.Server` - so this class tracks its own sockets in a `Set` (added in `handleConnection()`, removed on `"close"`) and `destroy()`s whatever's left after a `closeTimeoutMs` (default 30s, matching `smtp-server`'s own force-destroy magnitude). Test uses its own short-`closeTimeoutMs` instance (20ms), not the shared fixture, since the shared one's 30s default would make the test itself hang.
- **docker-compose.yml's DKIM comment was actively wrong, not just stale**: it claimed the image's DKIM backend was "rspamd (bundled since v6)" - it's OpenDKIM (see the 2026-09-19/2026-09-20 entries above), and the compose stack has none of the Helm chart's `dkim-keys-sync`/`dkim-sync.sh` mechanism. Corrected the comment and marked the stack eval/local-only for DKIM until that's ported over; no functional compose change.
- **Coverage:** 100%, new failure-mode tests added for all four code fixes (oversized message, hung upstream x3, `close()` with a live connection, comma-containing/non-ASCII recipient). `RELEASE_NOTES.md` gets a new `## Unreleased` entry per this repo's existing convention (confirmed via `git log -p -- RELEASE_NOTES.md`: a version heading is only ever applied by JP's own `1.x.y` version-bump commit) - `package.json`'s `version` was left untouched per this file's own standing decision.
