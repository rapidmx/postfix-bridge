# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/rapidmx/postfix-bridge/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/rapidmx/postfix-bridge/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/rapidmx/postfix-bridge/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/rapidmx/postfix-bridge/releases/tag/v1.0.0
