# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/rapidmx/postfix-bridge/compare/v1.4.1...HEAD
[1.4.1]: https://github.com/rapidmx/postfix-bridge/compare/v1.4.0...v1.4.1
[1.4.0]: https://github.com/rapidmx/postfix-bridge/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/rapidmx/postfix-bridge/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/rapidmx/postfix-bridge/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/rapidmx/postfix-bridge/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/rapidmx/postfix-bridge/releases/tag/v1.0.0
