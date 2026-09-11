///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
// Real SMTP client/server I/O against an ephemeral loopback port, using nodemailer (already a dependency,
// for outbound relay - see PostfixSendmailTransport) as the test client - no mocking of the protocol
// itself, only of MtaIngestClient (the one real external dependency this class has).
import * as nodemailer from "nodemailer";
import { SmtpDeliveryServer } from "../src/SmtpDeliveryServer.js";
import { MtaIngestClient } from "../src/MtaIngestClient.js";

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
