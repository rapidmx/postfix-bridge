# Release Notes

## Unreleased

### postfix-bridge

* Fixed a recipient list becoming ambiguous when an SMTP client sent a `RCPT TO` address with a literal comma inside a quoted local part (RFC 5321 permits this, and Postfix's own SMTP library accepts it unchanged): joining recipients with a bare `,` into the `X-Envelope-To` header could split one address into two on the receiving end. Every envelope address is now percent-encoded before being placed in a header, which also protects a non-ASCII (SMTPUTF8) local part from being mangled as a raw HTTP header value
* Fixed this bridge accepting an SMTP message of any size and buffering all of it into memory before handing it off: it now enforces a configurable maximum message size (`MTA_BRIDGE_MAX_MESSAGE_SIZE`, default 25 MiB) and rejects an over-limit message with a permanent `552` instead of buffering it in full
* Fixed an unresponsive RapidMX server being able to hang this bridge's `tcp_table`/SMTP listeners indefinitely: every upstream HTTP call now aborts after a configurable timeout (`MTA_INGEST_TIMEOUT_MS`, default 10s) and is treated the same as any other transient upstream failure
* Fixed graceful shutdown hanging forever if Postfix still held a `tcp_table` connection open (it's documented to reuse one connection for many sequential lookups): closing a `tcp_table` listener now force-closes any still-open connection after a timeout, matching the force-close behavior its SMTP delivery listener already had
* Documented in `docker-compose.yml` that its DKIM setup is stale relative to the Helm chart's `dkim-keys-sync`/`dkim-sync.sh` mechanism and is eval/local-only until it's hardened to match
* Fixed `MTA_BRIDGE_MAX_MESSAGE_SIZE`/`MTA_INGEST_TIMEOUT_MS` silently disabling the protections they configure when set to a blank, zero, or otherwise invalid value: a `NaN`/`0`/empty message-size cap made `smtp-server` fall back to no limit at all, with no error and a normal `250 OK` - reproducing the exact unbounded-buffering issue the cap above exists to close. Both env vars now fail fast at startup instead if set to anything other than a positive, finite number
* Fixed the same unbounded-buffering risk on the `tcp_table` side: a client that never sent a newline (or sent one extremely long line) could grow a `tcp_table` connection's line buffer without limit, in a synchronous handler outside any error handling - unlike the SMTP-side cap, this could exhaust the whole process's memory or crash it outright with an uncaught error, not just fail one connection. `tcp_table` connections now drop once a buffered, not-yet-terminated line exceeds a configurable size (`MTA_BRIDGE_MAX_LINE_LENGTH`, default 8 KiB), and this env var is validated the same fail-fast way as the other two
* Fixed `MTA_INGEST_TIMEOUT_MS` having no upper bound: a legitimately large value (for a slow upstream) could let an in-flight delivery call still be waiting when a rolling restart's shutdown force-close timeout (30s) destroys its socket, dropping the response and causing Postfix to retry - and duplicate - the whole delivery. `MTA_INGEST_TIMEOUT_MS` must now stay below 25 seconds (validated at startup) so it can never outlive that grace period

## v1.4.1

### Helm chart and docker-compose.yml

* Fixed every message the RapidMX server sent to another organisation (a reply to an external address, for one) silently vanishing: Postfix routed it to postfix-bridge instead of delivering it, because `transport_maps = static:smtp:postfix-bridge:2525` matches every recipient. The postfix-bridge accepted it, Postfix logged `status=sent`, and the server's ingest then dropped it as an unresolvable recipient. Postfix now sets `relay_transport = smtp:postfix-bridge:2525` instead, so only the domains the server serves (`relay_domains`) go to postfix-bridge and everything else is delivered by MX lookup. A failed delivery to an external recipient now bounces to the sender with Postfix's full diagnostic (for example `host mx.example.net[192.0.2.1] said: 550 5.1.1 ...`), delivered to the sender's mailbox through postfix-bridge like any other message for a domain the server serves. Upgrading restarts the Postfix pod, and its queue is not persistent: flush it first (`postqueue -f`)

## v1.4.0

### Helm chart

* **Domains added in the main service's admin console work at once, with no restart, no upgrade and no change to `domains`:** the right to send is asked of the main service (through the existing postfix-bridge domain lookup) for each message, and a small watcher (`dkim-sync.sh`, run by the image's own supervisord) copies each domain's DKIM key from the shared volume to where OpenDKIM reads it, rebuilds its key and signing tables and asks it to reload, within `dkim.syncIntervalSeconds` (default 10). A key the main service replaces is picked up the same way, and a domain removed there stops sending at once. `domains` is now only the set Postfix knows when it starts, so they may send while the main service is down
* Fixed the first domain's DKIM key never matching what the console tells you to publish until Postfix was restarted: Postfix signed with a key the image had generated, and only used the main service's after a restart
* Fixed OpenDKIM never verifying a signature, so no inbound `Authentication-Results` result was ever stamped: its key lookups through the container's resolver fail with `unexpected reply class/type (-1/-1)` unless it is told which name server to ask, so an init script points it at the pod's resolver
* Fixed anyone who could reach port 25 getting their mail signed as one of your domains: the image lists every address as OpenDKIM's internal hosts, so a message from the internet with a forged `From:` of your domain came back with your genuine DKIM signature; only `postfix.internalNetworks` are internal now

## v1.3.0

## v1.2.0

### Helm chart

* Fixed every DKIM check failing: the Postfix image signs with OpenDKIM using `/etc/opendkim/keys/<domain>.private`, which it
  generates itself, while the key in DNS is the one the main service writes to `/var/lib/rspamd/dkim`; an init container now copies the
  main service's key to where the image looks, so the signature verifies against the published record
* Fixed `domains` with more than one domain: the image splits `ALLOWED_SENDER_DOMAINS` on whitespace, so the comma-separated value is now
  passed with spaces
* Fixed Postfix bouncing every message it accepted with "Host or domain name not found ... name=postfix-bridge type=AAAA": its DNS client doesn't apply the pod's search domains, so it now falls back to the system resolver (`smtp_host_lookup = dns, native`)
* Fixed Postfix being an open relay for `domains` behind k3s' ServiceLB, which masks every client as an internal address
  that Postfix trusts (`mynetworks` covers 10.0.0.0/8): the `postfix` Service now sets `externalTrafficPolicy: Local`
  (`postfix.externalTrafficPolicy`), so Postfix sees the real client address
* Fixed Postfix rejecting all inbound internet mail (the image's send-only restrictions refuse any client outside
  `mynetworks`) and all outbound mail from the server (mandatory TLS on port 25 refused its plaintext hop): port 25 now
  accepts mail for the domains the server serves from anyone over TLS without relaying, and relays for clients in
  the new `postfix.internalNetworks`, in plaintext, only as one of `domains`
* `ingestSecretRef` (a Secret name and key) reads the ingest secret from a Secret something else owns, instead of this
  chart rendering its own - which is how the RapidMX server chart hands over the secret its OpenBao vault holds. With it
  set, `ingestSecret` isn't required and no Secret is rendered here.

## v1.1.0

Helm chart changes, so the RapidMX server's chart can bundle this one (as its `postfixBridge` dependency).

### Breaking changes

- **`ingestSecret` is required.** Its default is now empty instead of the `ChangeMeIngestSecret` placeholder, and the
  render fails while it's empty or still that placeholder. Set it to the server release's `mail.ingestSecret`.

### Features

- **Your own certificate or a self-signed one:** `tls.existingSecret` names a `kubernetes.io/tls` Secret to use for
  Postfix. `tls.certManager.enabled=false` self-signs the certificate for a public hostname too, for clusters without
  cert-manager, and `tls.certManager.issuerName`/`issuerKind` pick another issuer than the `letsencrypt-prod`
  ClusterIssuer.
- **Share the server's DKIM keys:** `dkim.storage.existingClaim` mounts an existing claim (the server's
  `<release>-dkim-keys`) instead of creating the chart's own, so Postfix signs with the keys the server's
  FsDkimKeyProvider writes and publishes in DNS. With `ReadWriteOnce` storage, the server and postfix pods must run on
  the same node.
- **Templates in values:** `hostname`, `domains`, `ingestSecret`, `ingestBaseUrl`, `dkim.storage.existingClaim` and
  `tls.existingSecret` may be templates (for example `'{{ .Values.global.mailIngestSecret }}'`).

### Fixes

- **Volumes stuck Pending:** `dkim.storage.storageClassName` was compared with `default` before being rendered, so the
  volumes always asked for a storage class literally named `default`, which most clusters (k3s included) don't have.
  `default` or empty now uses the cluster's default storage class.
- **Self-signed certificate replaced on every upgrade:** for localhost and `*.local` hostnames, the certificate is now
  kept while the hostname is unchanged.
- **Install notes and README** (the chart's `NOTES.txt`) referred to `mail.ingestBaseUrl` and `mail.ingestSecret`; the
  values are `ingestBaseUrl` and `ingestSecret`.

## v1.0.0

Bridges Postfix's `tcp_table`/SMTP protocols to a RapidMX server's `/internal/mta` ingest contract.
