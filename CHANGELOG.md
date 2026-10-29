# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.6.0] - 2026-10-29

### Added
- Added the missing "Enable corepack" step to the validate job - every other job already has it, and without it yarn runs the container's stock Yarn 1.22.22 instead of the packageManager-pinned version, which refuses to run at all against a packageManager field, so validate's yarn npm audit never actually ran regardless of real findings. Confirmed on rapidmx/server's identical job via a real CI log; this repo's validate job is the same template and shares the same latent gap even where it happened not to manifest yet
- Added dkim-sync.sh --once and the DKIM_KEYS_DIR and DKIM_TABLE_DIR settings, and run one pass in the dkim-keys-sync init container and in opendkim.sh before OpenDKIM starts, replacing the init container's own copy loop
- Added dkim-sync.sh tests running the script with real bash and openssl
- Added the rule that the more specific agent model assignment wins where categories overlap

### Changed
- Document that a downstream package's release bump level follows its upstream dependency's, minor for minor, patch for patch and major for major, in NOTES
- Document the standing wait-for-green-CI-before-releasing rule in NOTES, per JP
- Publish a release tag's image and chart only once every other job of its run and every other CI run of its commit has finished green
- Sign each domain in dkim-sync.sh with the DKIM selector the RapidMX server names in <domain>.selector, falling back to the global DKIM_SELECTOR for a domain without one, with the selector's key at /etc/opendkim/keys/<domain>/<selector>.private, the selector in use recorded in <domain>/selector and <domain>.private kept as a copy of that key
- Keep the key a domain moves off until the server deletes its source key and the previous pass's tables no longer name it, so messages on a session opened before OpenDKIM's reload are still signed
- Write <domain>.signing for each of the server's domains on the pass after the one that put its selector in the tables, and only while OpenDKIM runs
- Read only plain files from the shared DKIM volume and write <domain>.signing as an exclusive create under a random name renamed over it, never through a link or into a directory
- Correct the dkim-opendkim-keys comment, which described an opendkim-genkey layout the image never read
- Describe per-domain DKIM selectors in the README and release notes
- Refresh smtp-server, nodemailer, vite, brace-expansion, source-map-js and undici in the lockfile for high-severity advisories
- Name the node types in tsconfig.json, since smtp-server's own types no longer pull them in under TypeScript 6
- Record the standing agent model assignments in the project notes
- Move the agent model assignments to the top of the project notes, keeping session history at the bottom
- Update the agent model assignments to JP's revised criteria: Sonnet for general code and review, Opus for architecture, planning, investigation, security and performance, Haiku for simple operations
- Make dkim-sync.sh read words with the read builtin, split paths with parameter expansion, run openssl pkey only when the source key differs from the installed copy and rm only when the .txt file exists, so a pass over unchanged domains starts only the cmp calls, with a Cost of a pass test counting the processes
- Install corepack with npm before enabling it in both Dockerfile stages since node:lts-trixie-slim is Node 26, which no longer ships it

## [1.5.0] - 2026-09-23

### Added
- Added RELEASE_NOTES.md and README entries for the new env vars and fixes
- Added NOTES.md session log entry for this adversarial-review pass
- Added regression tests asserting both env vars reject invalid values before the bridge starts listening
- Added regression tests for both, and document the fixes in the README, RELEASE_NOTES.md and NOTES.md

### Changed
- Document that docker-compose.yml's DKIM setup is stale and eval/local-only relative to the Helm chart's dkim-keys-sync mechanism
- Document the fix in RELEASE_NOTES.md and NOTES.md

### Fixed
- Fixed a comma inside a quoted-local-part recipient making the X-Envelope-To header ambiguous by percent-encoding every envelope address before joining
- Fixed unbounded in-memory buffering of an SMTP message by capping message size (MTA_BRIDGE_MAX_MESSAGE_SIZE) and stopping buffering once smtp-server flags it exceeded
- Fixed a hung upstream HTTP call stalling every queued tcp_table lookup or the in-flight SMTP transaction by aborting every fetch after a configurable timeout (MTA_INGEST_TIMEOUT_MS)
- Fixed TcpTableServer.close() hanging forever when Postfix still holds a tcp_table connection open by force-closing tracked sockets after a timeout
- Fixed MTA_BRIDGE_MAX_MESSAGE_SIZE and MTA_INGEST_TIMEOUT_MS silently disabling the protections they configure by failing fast at startup on a blank, zero, or non-numeric value instead of falling back to no cap at all
- Fixed TcpTableServer's line buffer growing without limit for a client that never sends a newline by capping it with a configurable MTA_BRIDGE_MAX_LINE_LENGTH and destroying the connection once exceeded
- Fixed MTA_INGEST_TIMEOUT_MS having no upper bound by rejecting a value that could outlive the 30s shutdown force-close grace period, avoiding a dropped in-flight delivery response and duplicate retry

## [1.4.1] - 2026-09-20

### Changed
- Correct the comments and the README that described the routing as transport_maps
- Test the routing, and delivery status notifications captured from a real Postfix, with a null envelope sender, replayed over SMTP and posted to the server with an empty X-Envelope-From
- Document the fix in the README, the release notes and NOTES, including how to roll it out
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>

### Fixed
- Fixed mail for external recipients being delivered to postfix-bridge, and dropped by the server, by sending only relay_domains there with relay_transport instead of a static transport_maps that matched every recipient

## [1.4.0] - 2026-09-20

### Added
- Added dkim-sync.sh, run by the image's own supervisord, which copies each valid DKIM key the main service writes to the shared volume to where OpenDKIM reads it, rebuilds its key and signing tables and reloads it every dkim.syncIntervalSeconds, so a new domain signs with the key the console shows and a replaced key is picked up

### Changed
- Document the fixes in the release notes and NOTES
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Let a domain added in the main service's admin console send at once, with no restart, upgrade or change to domains, by asking the main service through postfix-bridge's existing domain lookup whether it serves an internal client's sender domain, chained after the static allowed_senders list with pipemap since Postfix does a single whole-address lookup for a chain that contains a pattern table
- Document that domains is only the set Postfix knows when it starts, and correct the chart comments that described the image's DKIM backend as rspamd and domains as a list to keep in sync with the console
- Document the changes in the README, the release notes and NOTES
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>

### Fixed
- Fixed OpenDKIM never verifying a signature, so no inbound Authentication-Results result was ever stamped, by pointing it at the pod's name server with an init script, since its key lookups through the container's resolver fail with "unexpected reply class/type (-1/-1)" otherwise
- Fixed anyone who could reach port 25 getting their mail signed as one of the allowed sender domains by making only postfix.internalNetworks OpenDKIM's internal hosts, where the image treated every address as internal
- Fixed the first domain signing with a key the image generated, not the one the console tells you to publish, until Postfix was restarted

## [1.3.0] - 2026-09-19

### Fixed
- Fixed release notes

- Read the ingest secret from a Secret another chart owns through ingestSecretRef, so a parent chart can hand over a value it holds elsewhere - the RapidMX server's OpenBao vault, delivered by External Secrets - instead of this chart rendering its own; ingestSecret isn't required with it set
- Note it in the release notes

## [1.2.0] - 2026-09-17

### Changed
- Restore the helm values.yaml comments the 1.1.0 release commit stripped, keeping the 1.1.0 image tag
- Document the restore in NOTES
- Read the ingest secret from a Secret another chart owns through ingestSecretRef, so a parent chart can hand over a value it holds elsewhere - the RapidMX server's OpenBao vault, delivered by External Secrets - instead of this chart rendering its own; ingestSecret isn't required with it set
- Note it in the release notes

## [1.1.0] - 2026-09-15

### Added
- Added dkim.storage.existingClaim to mount the RapidMX server's DKIM keys claim instead of creating the chart's own, so Postfix signs with the keys the server writes and publishes in DNS
- Added tls.existingSecret and tls.certManager.enabled, issuerName and issuerKind, self-signing the certificate when cert-manager is off or the hostname is localhost or *.local, and keep a self-signed certificate across upgrades while the hostname is unchanged

### Changed
- Render the chart's DKIM storage class before comparing it with "default", so the volumes use the cluster's default storage class instead of requesting a class literally named "default" and staying Pending
- Accept templates in hostname, domains, ingestSecret, ingestBaseUrl, dkim.storage.existingClaim and tls.existingSecret, so the server chart can pass its own values to the bundled chart
- Require ingestSecret and refuse the ChangeMeIngestSecret placeholder instead of deploying with it
- Use the real value names in the chart's NOTES.txt and the README, and document running the chart on its own
- Document the chart changes in the release notes and NOTES
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

## [1.0.0] - 2026-09-11

### Added
- Added badges to readme
- Added coverage reporting
- Added missing deps for test job
- Added more system deps for test job
- Added release script

### Changed
- Initial commit
- Updated readme
- Updated various files
- Restructuring helm values

### Fixed
- Fixed badge on readme
- Fixed ci
- Fixed helm issue

### Removed
- Removed @rapidrest/cli as a dep

[Unreleased]: https://github.com/rapidmx/postfix-bridge/compare/v1.6.0...HEAD
[1.6.0]: https://github.com/rapidmx/postfix-bridge/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/rapidmx/postfix-bridge/compare/v1.4.1...v1.5.0
[1.4.1]: https://github.com/rapidmx/postfix-bridge/compare/v1.4.0...v1.4.1
[1.4.0]: https://github.com/rapidmx/postfix-bridge/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/rapidmx/postfix-bridge/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/rapidmx/postfix-bridge/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/rapidmx/postfix-bridge/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/rapidmx/postfix-bridge/releases/tag/v1.0.0
