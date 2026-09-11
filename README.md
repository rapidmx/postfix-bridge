# RapidMX: Postfix Bridge

[![CI](https://github.com/rapidmx/postfix-bridge/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/rapidmx/postfix-bridge/actions/workflows/ci.yml)

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
| Tag          | 0.1.0                    |

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

A Helm chart is included that deploys this bridge and its own Postfix instance - deploy it alongside the
RapidMX server's own Helm chart (which owns the server, auth-server, datastores, and spam/AV scanning),
not instead of it.

```bash
helm install --create-namespace --namespace mail-server postfix-bridge oci://ghcr.io/rapidmx/charts/postfix-bridge --version 0.1.0
```

Or from a local checkout:

```bash
helm install --create-namespace --namespace mail-server postfix-bridge ./helm
```

Set `mail.ingestBaseUrl` to the RapidMX server release's own Service URL, and `mail.ingestSecret` to the
exact same value as that release's `mail__transport__ingest__secret` - the two are separate Helm releases,
so nothing keeps them in sync automatically. See `helm/values.yaml` for the full set of configurable values.

## Debugging

[Visual Studio Code](https://code.visualstudio.com/) is the recommended IDE to develop with. Run
`yarn debug` to start the bridge with the inspector attached, or attach to a container started from this
image on port `9229`.
