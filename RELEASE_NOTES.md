# Release Notes

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
