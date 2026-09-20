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
import { MtaIngestClient } from "./MtaIngestClient.js";
import { SmtpDeliveryServer } from "./SmtpDeliveryServer.js";
import { TcpTableServer } from "./TcpTableServer.js";

function requireEnv(name: string, fallback?: string): string {
    const value: string | undefined = process.env[name] ?? fallback;
    if (!value) {
        throw new Error(`${name} must be set (no default available).`);
    }
    return value;
}

const ingestBaseUrl: string = requireEnv("MTA_INGEST_BASE_URL", "http://server:3000/internal/mta");
const ingestSecret: string = requireEnv("MTA_INGEST_SECRET");
const domainPort: number = Number(process.env.MTA_BRIDGE_DOMAIN_PORT ?? 10040);
const recipientPort: number = Number(process.env.MTA_BRIDGE_RECIPIENT_PORT ?? 10041);
const smtpPort: number = Number(process.env.MTA_BRIDGE_SMTP_PORT ?? 2525);

const client: MtaIngestClient = new MtaIngestClient(ingestBaseUrl, ingestSecret);

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
const smtpServer: SmtpDeliveryServer = new SmtpDeliveryServer(client);

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
