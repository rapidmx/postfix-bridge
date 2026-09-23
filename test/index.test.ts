///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// `src/index.ts` wires three real network servers (TcpTableServer x2, SmtpDeliveryServer) to a real HTTP
// client (MtaIngestClient) and is never itself exercised by the other test files (they test each class in
// isolation, against real sockets). All three collaborators are mocked here instead - this file's own job
// is just the wiring (env parsing, which lookup goes to which server, startup/shutdown sequencing), not
// the network protocols those classes already have their own real-socket tests for.
const mockCheckDomain = vi.fn();
const mockResolveRecipient = vi.fn();
const mockDeliver = vi.fn();

const mockMtaIngestClient = vi.fn(function (
    this: Record<string, unknown>,
    baseUrl: string,
    secret: string,
    timeoutMs: number,
) {
    this.baseUrl = baseUrl;
    this.secret = secret;
    this.timeoutMs = timeoutMs;
    this.checkDomain = mockCheckDomain;
    this.resolveRecipient = mockResolveRecipient;
    this.deliver = mockDeliver;
});

vi.mock("../src/MtaIngestClient.js", () => ({ MtaIngestClient: mockMtaIngestClient, DEFAULT_MTA_INGEST_TIMEOUT_MS: 10_000 }));

let mockDomainListenShouldFail = false;
const mockTcpTableServerInstances: Array<{ lookup: (key: string) => unknown; listen: unknown; close: unknown }> = [];
const mockTcpTableServer = vi.fn(function (this: Record<string, unknown>, lookup: (key: string) => unknown) {
    this.lookup = lookup;
    const isDomainServer = mockTcpTableServerInstances.length === 0;
    this.listen =
        isDomainServer && mockDomainListenShouldFail
            ? vi.fn().mockRejectedValue(new Error("EADDRINUSE"))
            : vi.fn().mockResolvedValue(10040);
    this.close = vi.fn().mockResolvedValue(undefined);
    mockTcpTableServerInstances.push(this as unknown as { lookup: (key: string) => unknown; listen: unknown; close: unknown });
});

vi.mock("../src/TcpTableServer.js", () => ({ TcpTableServer: mockTcpTableServer }));

const mockSmtpDeliveryServerInstances: Array<{
    client: unknown;
    maxMessageSize: unknown;
    listen: unknown;
    close: unknown;
}> = [];
const mockSmtpDeliveryServer = vi.fn(function (this: Record<string, unknown>, client: unknown, maxMessageSize: unknown) {
    this.client = client;
    this.maxMessageSize = maxMessageSize;
    this.listen = vi.fn().mockResolvedValue(2525);
    this.close = vi.fn().mockResolvedValue(undefined);
    mockSmtpDeliveryServerInstances.push(
        this as unknown as { client: unknown; maxMessageSize: unknown; listen: unknown; close: unknown },
    );
});

vi.mock("../src/SmtpDeliveryServer.js", () => ({ SmtpDeliveryServer: mockSmtpDeliveryServer, DEFAULT_MAX_MESSAGE_SIZE: 26_214_400 }));

async function importIndexFresh(): Promise<void> {
    vi.resetModules();
    await import("../src/index.js");
}

describe("index", () => {
    let consoleLogSpy: ReturnType<typeof vi.spyOn>;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
    let processExitSpy: ReturnType<typeof vi.spyOn>;
    let processOnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        delete process.env.MTA_INGEST_BASE_URL;
        delete process.env.MTA_INGEST_SECRET;
        delete process.env.MTA_BRIDGE_DOMAIN_PORT;
        delete process.env.MTA_BRIDGE_RECIPIENT_PORT;
        delete process.env.MTA_BRIDGE_SMTP_PORT;
        delete process.env.MTA_INGEST_TIMEOUT_MS;
        delete process.env.MTA_BRIDGE_MAX_MESSAGE_SIZE;
        process.env.MTA_INGEST_SECRET = "test-secret";

        mockDomainListenShouldFail = false;
        mockTcpTableServerInstances.length = 0;
        mockSmtpDeliveryServerInstances.length = 0;

        consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
        consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        processExitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
        processOnSpy = vi.spyOn(process, "on");
    });

    afterEach(() => {
        consoleLogSpy.mockRestore();
        consoleErrorSpy.mockRestore();
        processExitSpy.mockRestore();
        processOnSpy.mockRestore();
        process.removeAllListeners("SIGINT");
        process.removeAllListeners("SIGTERM");
    });

    it("throws when MTA_INGEST_SECRET is not set", async () => {
        delete process.env.MTA_INGEST_SECRET;
        await expect(importIndexFresh()).rejects.toThrow("MTA_INGEST_SECRET must be set");
    });

    it("uses the default ingest base URL, ports, timeout, and max message size when their env vars are unset", async () => {
        await importIndexFresh();

        expect(mockMtaIngestClient).toHaveBeenCalledWith("http://server:3000/internal/mta", "test-secret", 10_000);
        await vi.waitFor(() => expect((mockTcpTableServerInstances[0].listen as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(10040));
        expect(mockTcpTableServerInstances[1].listen).toHaveBeenCalledWith(10041);
        expect(mockSmtpDeliveryServerInstances[0].listen).toHaveBeenCalledWith(2525);
        expect(mockSmtpDeliveryServerInstances[0].maxMessageSize).toBe(26_214_400);
    });

    it("uses overridden ingest base URL, ports, timeout, and max message size from env vars when set", async () => {
        process.env.MTA_INGEST_BASE_URL = "http://custom-server:4000/internal/mta";
        process.env.MTA_BRIDGE_DOMAIN_PORT = "20040";
        process.env.MTA_BRIDGE_RECIPIENT_PORT = "20041";
        process.env.MTA_BRIDGE_SMTP_PORT = "3525";
        process.env.MTA_INGEST_TIMEOUT_MS = "5000";
        process.env.MTA_BRIDGE_MAX_MESSAGE_SIZE = "1048576";

        await importIndexFresh();

        expect(mockMtaIngestClient).toHaveBeenCalledWith("http://custom-server:4000/internal/mta", "test-secret", 5000);
        await vi.waitFor(() => expect(mockTcpTableServerInstances[0].listen).toHaveBeenCalledWith(20040));
        expect(mockTcpTableServerInstances[1].listen).toHaveBeenCalledWith(20041);
        expect(mockSmtpDeliveryServerInstances[0].listen).toHaveBeenCalledWith(3525);
        expect(mockSmtpDeliveryServerInstances[0].maxMessageSize).toBe(1_048_576);
    });

    it("the domain server's lookup maps a found/not-found domain check to a tcp_table result", async () => {
        await importIndexFresh();
        const domainLookup = mockTcpTableServerInstances[0].lookup;

        mockCheckDomain.mockResolvedValue(true);
        await expect(domainLookup("example.com")).resolves.toEqual({ found: true, value: "example.com" });
        expect(mockCheckDomain).toHaveBeenCalledWith("example.com");

        mockCheckDomain.mockResolvedValue(false);
        await expect(domainLookup("nobody.example.com")).resolves.toEqual({ found: false });
    });

    it("the recipient server's lookup maps a found/not-found recipient check to a tcp_table result", async () => {
        await importIndexFresh();
        const recipientLookup = mockTcpTableServerInstances[1].lookup;

        mockResolveRecipient.mockResolvedValue(true);
        await expect(recipientLookup("a@example.com")).resolves.toEqual({ found: true, value: "a@example.com" });
        expect(mockResolveRecipient).toHaveBeenCalledWith("a@example.com");

        mockResolveRecipient.mockResolvedValue(false);
        await expect(recipientLookup("nobody@example.com")).resolves.toEqual({ found: false });
    });

    it("logs a startup message with the bound ports and ingest URL once every server is listening", async () => {
        await importIndexFresh();

        await vi.waitFor(() =>
            expect(consoleLogSpy).toHaveBeenCalledWith(
                expect.stringContaining("postfix-bridge listening: domain=10040 recipient=10041 smtp=2525, forwarding to http://server:3000/internal/mta"),
            ),
        );
    });

    it("logs the error and exits with code 1 if a server fails to start listening", async () => {
        mockDomainListenShouldFail = true;

        await importIndexFresh();

        await vi.waitFor(() => expect(consoleErrorSpy).toHaveBeenCalledWith("postfix-bridge failed to start:", expect.any(Error)));
        expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it("closes every server, logs a shutdown message, and exits 0 on SIGINT/SIGTERM", async () => {
        await importIndexFresh();
        await vi.waitFor(() => expect(mockTcpTableServerInstances[0].listen).toHaveBeenCalled());

        expect(processOnSpy).toHaveBeenCalledWith("SIGINT", expect.any(Function));
        expect(processOnSpy).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
        const shutdownHandler = processOnSpy.mock.calls.find((call) => call[0] === "SIGINT")?.[1] as () => Promise<void>;

        await shutdownHandler();

        expect(consoleLogSpy).toHaveBeenCalledWith("postfix-bridge shutting down...");
        expect(mockTcpTableServerInstances[0].close).toHaveBeenCalled();
        expect(mockTcpTableServerInstances[1].close).toHaveBeenCalled();
        expect(mockSmtpDeliveryServerInstances[0].close).toHaveBeenCalled();
        expect(processExitSpy).toHaveBeenCalledWith(0);
    });
});
