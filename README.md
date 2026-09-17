# RapidMX: Postfix Bridge

[![CI](https://github.com/RapidMX/postfix-bridge/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/RapidMX/postfix-bridge/actions/workflows/ci.yml)
[![Coverage Status](https://coveralls.io/repos/github/RapidMX/postfix-bridge/badge.svg?branch=main)](https://coveralls.io/github/RapidMX/postfix-bridge?branch=main)
[![docker version](https://github.com/rapidmx/server/pkgs/container/server/badge.svg)](https://github.com/rapidmx/server/pkgs/container/server)
[![helm version](https://github.com/rapidmx/server/pkgs/container/charts%2Fmail-server/badge.svg)](https://github.com/rapidmx/server/pkgs/container/charts%2Fmail-server)

Provides a bridge between Postfix and the RapidMX server.

Bridges Postfix's own protocols, `tcp_table` lookups for recipient/domain validation, plain SMTP for
final delivery hand-off, to the `MTAIngestAdapter` HTTP contract a [RapidMX server](https://github.com/rapidmx/server) exposes at `/internal/mta`. It is a small, standalone Node.js service.

## Getting Started

```bash
git clone https://github.com/rapidmx/postfix-bridge
cd postfix-bridge
yarn install
yarn build
yarn start
```

| Environment variable       | Purpose                                                                 |
| --------------------------- | ------------------------------------------------------------------------ |
| `MTA_INGEST_BASE_URL`      | Base URL of the RapidMX server's `/internal/mta` contract (default `http://server:3000/internal/mta`) |
| `MTA_INGEST_SECRET`        | Bearer secret authenticating this bridge's calls - must match that server's `mail__transport__ingest__secret` |
| `MTA_BRIDGE_DOMAIN_PORT`   | `tcp_table` port for `relay_domains` (default `10040`)                  |
| `MTA_BRIDGE_RECIPIENT_PORT`| `tcp_table` port for `relay_recipient_maps` (default `10041`)            |
| `MTA_BRIDGE_SMTP_PORT`     | Plain SMTP port for `transport_maps` final delivery (default `2525`)     |

## Deployment

| Docker Image |                          |
| ------------ | :----------------------: |
| Registry     | ghcr.io                  |
| Repository   | /rapidmx/postfix-bridge      |
| Tag          | 1.2.0                    |

### Docker Compose

`docker-compose.yml` brings up this bridge together with its own Postfix instance - the two are meant to
be run alongside the RapidMX server's own compose stack (a separate `docker compose` project), not in
place of it.

```bash
docker compose up -d --build
```

By default `postfix-bridge` reaches the RapidMX server via `http://host.docker.internal:3000/internal/mta`,
i.e. whatever that server publishes on the host's own `localhost:3000`. Override in a `.env` file next to
this compose file for anything beyond local, single-host evaluation:

| Variable | Purpose |
| --- | --- |
| `MTA_INGEST_BASE_URL` | Base URL of the RapidMX server's `/internal/mta` contract |
| `MTA_INGEST_SECRET` | Bearer secret - must match the RapidMX server's own `MAIL_INGEST_SECRET` |
| `MAIL_DOMAINS` | Comma-separated domains Postfix accepts *outbound* submissions for (`ALLOWED_SENDER_DOMAINS`) - keep in sync with the `Domain`s added via the RapidMX admin console |
| `MAIL_HOSTNAME` | Postfix's public MX hostname - drives its HELO/EHLO identity and the CN of the TLS certificate `postfix-tls-init` bootstraps |
| `DKIM_AUTOGENERATE` / `DKIM_SELECTOR` | DKIM key handling - see `docker-compose.yml`'s own comments |

The `dkim_rspamd_keys`/`dkim_opendkim_keys`/`postfix_tls` named volumes persist DKIM keys and the Postfix
TLS certificate across `docker compose down`/`up` - don't remove them (`docker compose down -v`) unless
you actually want to start over. `dkim_rspamd_keys` in particular needs to be shared with the RapidMX
server's own compose stack (its `FsDkimKeyProvider` writes into it) - point both stacks at the same
underlying volume for that to work outside of local single-host evaluation.

**Mail transport security:** Postfix's two internet-facing directions - inbound `smtpd` on port 25 and
outbound `smtp` client delivery - both require TLS (`_tls_security_level=encrypt`), not just offer it
opportunistically. `postfix-tls-init` bootstraps a self-signed certificate for `MAIL_HOSTNAME` on first
start so this works with zero setup; replace the `postfix_tls` volume's `tls.crt`/`tls.key` with a real
certificate (e.g. Let's Encrypt) for anything beyond local evaluation. The one hop deliberately exempted
from mandatory TLS is Postfix -> `postfix-bridge` (see `docker/postfix/tls_policy.txt`), since that's internal
to the compose network and has no TLS support of its own by design.

### Kubernetes

A Helm chart is included that deploys this bridge and its own Postfix instance. The RapidMX server's Helm chart bundles
it as its `postfixBridge` dependency and wires it up, so you only need to install this chart on its own when the server
runs with `postfixBridge.create=false`.

```bash
helm install --create-namespace --namespace mail-server postfix-bridge oci://ghcr.io/rapidmx/charts/postfix-bridge --version 1.2.0
```

Or from a local checkout:

```bash
helm install --create-namespace --namespace mail-server postfix-bridge ./helm
```

Installed on its own, set:

- `ingestSecret` (required) to the exact same value as the server release's `mail.ingestSecret`, and `ingestBaseUrl` to
  that release's Service (`http://<release>-services/internal/mta`) - nothing keeps separate releases in sync;
- `hostname` to Postfix's public MX host name and `domains` to the domains it sends mail for;
- `dkim.storage.existingClaim` to the server's DKIM keys claim (`<release>-dkim-keys`), so Postfix signs with the keys
  the server publishes in DNS;
- `tls.existingSecret` to use your own certificate, or `tls.certManager.enabled=false` to self-sign one for a public
  hostname when cert-manager (with the `letsencrypt-prod` ClusterIssuer, `tls.certManager.issuerName`) isn't available.

See `helm/values.yaml` for the full set of configurable values.

## Debugging

[Visual Studio Code](https://code.visualstudio.com/) is the recommended IDE to develop with. Run
`yarn debug` to start the bridge with the inspector attached, or attach to a container started from this
image on port `9229`.
