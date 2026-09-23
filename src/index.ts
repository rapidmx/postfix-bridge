#!/usr/bin/env node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Bridges Postfix's own protocols (tcp_table lookups for recipient/domain validation, plain SMTP for
// final delivery hand-off) to the `MTAIngestAdapter` HTTP contract `@rapidmx/restapi`'s BaseMailIngestRoute
// exposes at `/internal/mta` (see @rapidmx/restapi's src/transport/MTAIngestAdapter.ts) - this is the
// "real, non-trivial follow-up work" .claude/NOTES.md flagged repeatedly as not yet built. Deliberately a
// standalone script with no @rapidrest DI/ORM machinery of its own - it owns no data and makes no
// decisions beyond "translate this protocol frame into that HTTP call", so it doesn't need any of that.
//
// Run as its own docker-compose service (`postfix-bridge`) using this same image - see docker-compose.yml.
import { DEFAULT_MTA_INGEST_TIMEOUT_MS, MtaIngestClient } from "./MtaIngestClient.js";
import { DEFAULT_MAX_MESSAGE_SIZE, SmtpDeliveryServer } from "./SmtpDeliveryServer.js";
import { TcpTableServer } from "./TcpTableServer.js";

function requireEnv(name: string, fallback?: string): string {
    const value: string | undefined = process.env[name] ?? fallback;
    if (!value) {
        throw new Error(`${name} must be set (no default available).`);
    }
    return value;
}

/**
 * Parses a numeric env var, falling back to `fallback` when unset, but failing fast (rather than silently
 * falling back to something unbounded/nonsensical) when it's *set* to something that isn't a positive,
 * finite number. Both this bridge's own two numeric env vars have exactly that failure mode downstream if a
 * blank/placeholder/malformed value slips through. `SmtpDeliveryServer`'s `size` option
 * (`MTA_BRIDGE_MAX_MESSAGE_SIZE`) is handed straight to `smtp-server`, whose own `startDataMode()` computes
 * `(maxBytes && Number(maxBytes)) || Infinity` - `NaN`, `0`, or `""` are all falsy, so the message-size cap
 * this bridge exists to enforce would silently become *no cap at all*, with no error, no log line, and a
 * normal `250 OK` - reproducing the exact unbounded-buffering issue that option was added to close.
 * `MtaIngestClient`'s `timeoutMs` (`MTA_INGEST_TIMEOUT_MS`) is handed to `AbortSignal.timeout()`, which
 * throws synchronously for `NaN`/a negative number - every domain check/recipient resolution/delivery would
 * then permanently temp-fail from the first request onward. Loud rather than silent, but still better
 * diagnosed at startup than at the first SMTP conversation.
 *
 * This repo's own `.claude/NOTES.md` history has more than one prior bug of exactly this "blank/placeholder
 * env value slips through Helm templating" shape, so this validates defensively even though neither env var
 * is wired into the Helm chart/docker-compose.yml yet.
 */
function requirePositiveNumber(name: string, fallback: number): number {
    const raw: string | undefined = process.env[name];
    if (raw === undefined) {
        return fallback;
    }
    const value: number = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`${name} must be a positive number if set (got '${raw}').`);
    }
    return value;
}

const ingestBaseUrl: string = requireEnv("MTA_INGEST_BASE_URL", "http://server:3000/internal/mta");
const ingestSecret: string = requireEnv("MTA_INGEST_SECRET");
const domainPort: number = Number(process.env.MTA_BRIDGE_DOMAIN_PORT ?? 10040);
const recipientPort: number = Number(process.env.MTA_BRIDGE_RECIPIENT_PORT ?? 10041);
const smtpPort: number = Number(process.env.MTA_BRIDGE_SMTP_PORT ?? 2525);
// How long every upstream call to the RapidMX server may take before this bridge gives up and maps it to
// Postfix's own temporary-failure convention - see MtaIngestClient's own `timeoutMs` doc for why.
const ingestTimeoutMs: number = requirePositiveNumber("MTA_INGEST_TIMEOUT_MS", DEFAULT_MTA_INGEST_TIMEOUT_MS);
// Caps one SMTP transaction's message size - see SmtpDeliveryServer's own `maxMessageSize` doc for why.
const maxMessageSize: number = requirePositiveNumber("MTA_BRIDGE_MAX_MESSAGE_SIZE", DEFAULT_MAX_MESSAGE_SIZE);

const client: MtaIngestClient = new MtaIngestClient(ingestBaseUrl, ingestSecret, ingestTimeoutMs);

// `relay_domains = tcp:postfix-bridge:<domainPort>` - consulted once per RCPT TO, before relay_recipient_maps.
const domainServer: TcpTableServer = new TcpTableServer(async (domain) => {
    const found: boolean = await client.checkDomain(domain);
    return found ? { found: true, value: domain } : { found: false };
});

// `relay_recipient_maps = tcp:postfix-bridge:<recipientPort>` - the actual mailbox/distribution-list existence
// check, consulted for every recipient of a domain relay_domains already accepted.
const recipientServer: TcpTableServer = new TcpTableServer(async (address) => {
    const found: boolean = await client.resolveRecipient(address);
    return found ? { found: true, value: address } : { found: false };
});

// `relay_transport = smtp:postfix-bridge:<smtpPort>` - the delivery hop for everything relay_domains accepted, and only
// that: a `static:` transport_maps entry would send every recipient here, external addresses included.
const smtpServer: SmtpDeliveryServer = new SmtpDeliveryServer(client, maxMessageSize);

async function start(): Promise<void> {
    await Promise.all([domainServer.listen(domainPort), recipientServer.listen(recipientPort), smtpServer.listen(smtpPort)]);
    console.log(
        `postfix-bridge listening: domain=${domainPort} recipient=${recipientPort} smtp=${smtpPort}, ` +
            `forwarding to ${ingestBaseUrl}`,
    );
}

void start().catch((err) => {
    console.error("postfix-bridge failed to start:", err);
    process.exit(1);
});

const shutdown = async (): Promise<void> => {
    console.log("postfix-bridge shutting down...");
    await Promise.allSettled([domainServer.close(), recipientServer.close(), smtpServer.close()]);
    process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
