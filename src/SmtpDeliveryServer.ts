///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as net from "net";
import { SMTPServer, SMTPServerAddress, SMTPServerDataStream, SMTPServerSession } from "smtp-server";
import { MtaIngestClient } from "./MtaIngestClient.js";

/** Default cap (bytes) on one SMTP transaction's message size - see the constructor's `maxMessageSize` doc
 * for why this exists at all. 25 MiB matches what several large mailbox providers advertise as their own
 * inbound limit. */
export const DEFAULT_MAX_MESSAGE_SIZE = 25 * 1024 * 1024;

/**
 * The final-delivery side of this bridge: a plain SMTP server Postfix relays already-accepted mail to
 * (via `relay_transport` - see docker-compose.yml) once its own recipient-validation checks
 * (`TcpTableServer` + `MtaIngestClient.resolveRecipient()`) have already passed. Every message received
 * here is, by construction, already known-deliverable - this class's only job is to buffer the raw
 * message and hand the whole SMTP transaction off to `POST /internal/mta/deliver` in one call, matching
 * that route's "a single SMTP transaction can carry more than one RCPT TO" contract (see
 * `@rapidmx/restapi`'s `BaseMailIngestRoute.deliver()` doc comment) rather than splitting it into one
 * upstream call per recipient.
 *
 * No auth/TLS of its own - this listens only on the compose/cluster-internal network, reachable solely
 * from the deployment's own Postfix container (see docker-compose.yml's `relay_transport` wiring);
 * the internal bearer secret is enforced one hop later, by `MtaIngestClient`/`BaseMailIngestRoute` itself.
 *
 * @author Jean-Philippe Steinmetz
 */
export class SmtpDeliveryServer {
    private readonly server: SMTPServer;

    public constructor(
        private readonly client: MtaIngestClient,
        /** Caps how much of one SMTP transaction's message this class will buffer into memory (via
         * `smtp-server`'s own `size` option) before rejecting it. Without this, `handleData()` below would
         * push every incoming chunk onto an unbounded array regardless of size - a sender (already known-
         * deliverable, by construction, so nothing upstream of this class enforces a limit) could exhaust
         * this process's memory with one arbitrarily large message. `smtp-server` only enforces `size`
         * against a client-declared `MAIL FROM:<addr> SIZE=nnn` up front - the actual transfer is not
         * capped by the library itself, so `handleData()` also checks `stream.sizeExceeded` per chunk (see
         * its own comment) to stop buffering as soon as the limit is crossed, not just reject after the
         * fact. */
        private readonly maxMessageSize: number = DEFAULT_MAX_MESSAGE_SIZE,
    ) {
        this.server = new SMTPServer({
            authOptional: true,
            disabledCommands: ["AUTH", "STARTTLS"],
            size: this.maxMessageSize,
            onData: (stream: SMTPServerDataStream, session: SMTPServerSession, callback: (err?: Error) => void) => {
                void this.handleData(stream, session, callback);
            },
        });
    }

    private async handleData(
        stream: SMTPServerDataStream,
        session: SMTPServerSession,
        callback: (err?: Error) => void,
    ): Promise<void> {
        const chunks: Buffer[] = [];
        stream.on("data", (chunk: Buffer) => {
            // Stop buffering the instant the cap is crossed - `stream.sizeExceeded` is smtp-server's own
            // running "have we gone over `size`" flag (see its README's "Using the SIZE extension"
            // section); it does not stop the transfer or reject the message on its own; the "end" handler
            // below is what does that.
            if (!stream.sizeExceeded) {
                chunks.push(chunk);
            }
        });
        stream.on("error", (err: Error) => callback(err));
        stream.on("end", () => {
            void (async () => {
                if (stream.sizeExceeded) {
                    // 5xx (permanent): the message is too big and won't become smaller on retry, unlike
                    // the 4xx upstream-failure path below.
                    const error: any = new Error(`Message exceeds maximum allowed size of ${this.maxMessageSize} bytes`);
                    error.responseCode = 552;
                    callback(error);
                    return;
                }
                try {
                    const raw: Buffer = Buffer.concat(chunks);
                    const envelopeFrom: string = session.envelope.mailFrom ? session.envelope.mailFrom.address : "";
                    const envelopeTo: string[] = session.envelope.rcptTo.map((r: SMTPServerAddress) => r.address);
                    await this.client.deliver(envelopeFrom, envelopeTo, raw);
                    callback();
                } catch (err: any) {
                    // 4xx (not 5xx): the recipient(s) were already validated before Postfix relayed this
                    // transaction here, so a failure at this stage is this bridge/upstream's own problem
                    // (a transient network/HTTP error), not a reason to bounce the message back to its
                    // original sender - let Postfix's own queue retry the relay instead.
                    const error: any = new Error(`Delivery hand-off failed: ${err.message}`);
                    error.responseCode = 450;
                    callback(error);
                }
            })();
        });
    }

    /** Resolves with the actual bound port - the same value given for `port`, unless `port` was `0`, in
     * which case the OS assigned an ephemeral one (used by this class's own tests). */
    public listen(port: number, host: string = "0.0.0.0"): Promise<number> {
        return new Promise((resolve, reject) => {
            this.server.on("error", reject);
            const netServer: net.Server = this.server.listen(port, host, () =>
                resolve((netServer.address() as net.AddressInfo).port),
            );
        });
    }

    public close(): Promise<void> {
        return new Promise((resolve) => this.server.close(() => resolve()));
    }
}
