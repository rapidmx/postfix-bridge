# Release Notes

## Unreleased

### Helm chart

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
