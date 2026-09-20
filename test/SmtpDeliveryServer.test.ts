///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
// Real SMTP client/server I/O against an ephemeral loopback port, using nodemailer (already a dependency,
// for outbound relay - see PostfixSendmailTransport) as the test client - no mocking of the protocol
// itself, only of MtaIngestClient (the one real external dependency this class has).
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as net from "node:net";
import * as nodemailer from "nodemailer";
import { SmtpDeliveryServer } from "../src/SmtpDeliveryServer.js";
import { MtaIngestClient } from "../src/MtaIngestClient.js";

function fixture(name: string): Buffer {
    return fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
}

/** Plays one SMTP transaction over a real socket, sending each command only after the previous reply, and resolves with
 * every reply line in order. Raw sockets, not nodemailer, because the point is the exact bytes Postfix puts on the wire. */
function smtpTransaction(port: number, steps: (string | Buffer)[]): Promise<string[]> {
    return new Promise((resolve, reject) => {
        const replies: string[] = [];
        let pending = "";
        let next = 0;
        const socket = net.connect(port, "127.0.0.1");
        socket.on("error", reject);
        socket.on("data", (chunk: Buffer) => {
            pending += chunk.toString("latin1");
            let end: number;
            // A reply is complete at a line of the form "250 text" (a "-" after the code means more lines follow).
            while ((end = pending.search(/^\d{3} .*\r\n/m)) !== -1) {
                const lineEnd = pending.indexOf("\r\n", end) + 2;
                replies.push(pending.slice(0, lineEnd).trimEnd());
                pending = pending.slice(lineEnd);
                if (next < steps.length) {
                    socket.write(steps[next++]);
                } else {
                    socket.end();
                }
            }
        });
        socket.on("close", () => resolve(replies));
    });
}

describe("SmtpDeliveryServer Tests", () => {
    let server: SmtpDeliveryServer;
    let port: number;
    let deliverMock: ReturnType<typeof vi.fn>;

    async function start(): Promise<void> {
        deliverMock = vi.fn().mockResolvedValue(undefined);
        const client = { deliver: deliverMock } as unknown as MtaIngestClient;
        server = new SmtpDeliveryServer(client);
        port = await server.listen(0, "127.0.0.1");
    }

    afterEach(async () => {
        await server.close();
    });

    it("Hands off the raw message and envelope (including multiple recipients) to deliver().", async () => {
        await start();
        const transport = nodemailer.createTransport({ host: "127.0.0.1", port, secure: false, tls: { rejectUnauthorized: false } });

        await transport.sendMail({
            envelope: { from: "a@example.com", to: ["b@example.com", "c@example.com"] },
            raw: "From: a@example.com\r\nTo: b@example.com\r\nSubject: Hi\r\n\r\nBody\r\n",
        });

        expect(deliverMock).toHaveBeenCalledTimes(1);
        const [envelopeFrom, envelopeTo, raw] = deliverMock.mock.calls[0];
        expect(envelopeFrom).toBe("a@example.com");
        expect(envelopeTo).toEqual(["b@example.com", "c@example.com"]);
        expect(raw.toString()).toContain("Subject: Hi");
    });

    it("Passes an empty envelopeFrom when session.envelope.mailFrom is false (a null reverse-path/bounce).", async () => {
        // Drives the private handleData() directly with a fake stream/session - smtp-server's own wire
        // behavior for `MAIL FROM:<>` isn't something this bridge controls or should depend on to exercise
        // this branch reliably (session.envelope.mailFrom is typed `false | SMTPServerAddress`).
        await start();
        const stream = new EventEmitter();
        const session = { envelope: { mailFrom: false, rcptTo: [{ address: "b@example.com" }] } };
        const callback = vi.fn();

        const handleData = (server as any).handleData.bind(server) as (s: unknown, sess: unknown, cb: unknown) => Promise<void>;
        void handleData(stream, session, callback);
        stream.emit("data", Buffer.from("Body"));
        stream.emit("end");
        await vi.waitFor(() => expect(callback).toHaveBeenCalled());

        expect(deliverMock).toHaveBeenCalledWith("", ["b@example.com"], expect.any(Buffer));
        expect(callback).toHaveBeenCalledWith();
    });

    it("Accepts a real null-sender bounce (MAIL FROM:<>) from Postfix and forwards an empty envelope-from and the exact DSN bytes.", async () => {
        // dsn-unknown-recipient-550.eml is the message Postfix generated (and this bridge forwarded to
        // /internal/mta/deliver) when a recipient's MX refused with a 550; the commands below are the ones it sent.
        await start();
        const dsn = fixture("dsn-unknown-recipient-550.eml");

        const replies = await smtpTransaction(port, [
            "EHLO mail.owned.lab\r\n",
            "MAIL FROM:<> BODY=8BITMIME\r\n",
            "RCPT TO:<alice@owned.lab>\r\n",
            "DATA\r\n",
            Buffer.concat([dsn, Buffer.from(".\r\n")]),
            "QUIT\r\n",
        ]);

        expect(replies.map((r) => r.slice(0, 3))).toEqual(["220", "250", "250", "250", "354", "250", "221"]);
        expect(deliverMock).toHaveBeenCalledTimes(1);
        const [envelopeFrom, envelopeTo, raw] = deliverMock.mock.calls[0];
        expect(envelopeFrom).toBe("");
        expect(envelopeTo).toEqual(["alice@owned.lab"]);
        expect(Buffer.compare(raw, dsn)).toBe(0);
    });

    it("Forwards the null sender of every kind of Postfix DSN (failed, expired, delayed) the same way.", async () => {
        await start();
        for (const name of ["dsn-expired-450.eml", "dsn-delayed-450.eml"]) {
            deliverMock.mockClear();
            const dsn = fixture(name);
            const replies = await smtpTransaction(port, [
                "EHLO mail.owned.lab\r\n",
                "MAIL FROM:<>\r\n",
                "RCPT TO:<alice@owned.lab>\r\n",
                "DATA\r\n",
                Buffer.concat([dsn, Buffer.from(".\r\n")]),
                "QUIT\r\n",
            ]);
            expect(replies[5]).toMatch(/^250 /);
            expect(deliverMock).toHaveBeenCalledWith("", ["alice@owned.lab"], expect.any(Buffer));
            expect(Buffer.compare(deliverMock.mock.calls[0][2], dsn)).toBe(0);
        }
    });

    it("Invokes the callback with the stream's error if the incoming data stream errors.", async () => {
        await start();
        const stream = new EventEmitter();
        const session = { envelope: { mailFrom: { address: "a@example.com" }, rcptTo: [{ address: "b@example.com" }] } };
        const callback = vi.fn();

        const handleData = (server as any).handleData.bind(server) as (s: unknown, sess: unknown, cb: unknown) => Promise<void>;
        void handleData(stream, session, callback);
        const streamError = new Error("stream broke");
        stream.emit("error", streamError);
        await vi.waitFor(() => expect(callback).toHaveBeenCalled());

        expect(callback).toHaveBeenCalledWith(streamError);
        expect(deliverMock).not.toHaveBeenCalled();
    });

    it("Rejects the SMTP transaction with a 4xx (retryable) code when deliver() fails.", async () => {
        deliverMock = vi.fn();
        await start();
        (server as any).client.deliver = vi.fn().mockRejectedValue(new Error("upstream unreachable"));
        const transport = nodemailer.createTransport({ host: "127.0.0.1", port, secure: false, tls: { rejectUnauthorized: false } });

        await expect(
            transport.sendMail({
                envelope: { from: "a@example.com", to: ["b@example.com"] },
                raw: "From: a@example.com\r\n\r\nHi\r\n",
            }),
        ).rejects.toThrow(/450/);
    });
});
