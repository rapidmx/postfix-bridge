///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
// Real socket I/O against an ephemeral loopback port - no mocking needed since this class *is* the
// protocol/socket boundary, mirroring @rapidmx/restapi's own convention for its filesystem-boundary
// adapters (LocalFsBlobStore, FsDkimKeyProvider).
import * as net from "net";
import { TcpTableServer, TcpTableLookup } from "../src/TcpTableServer.js";

/** Sends one raw line to `port` on loopback and resolves with the single response line (no trailing
 * newline). Opens a fresh connection per call, matching how a real `tcp_table(5)` client is documented to
 * behave (no assumption of a persistent, pipelined connection). */
function sendLine(port: number, line: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection({ port, host: "127.0.0.1" }, () => {
            socket.write(`${line}\n`);
        });
        socket.setEncoding("utf-8");
        let buffer = "";
        socket.on("data", (chunk: string) => {
            buffer += chunk;
            if (buffer.includes("\n")) {
                socket.end();
                resolve(buffer.split("\n")[0]);
            }
        });
        socket.on("error", reject);
    });
}

describe("TcpTableServer Tests", () => {
    let server: TcpTableServer;
    let port: number;

    async function start(lookup: TcpTableLookup): Promise<void> {
        server = new TcpTableServer(lookup);
        port = await server.listen(0, "127.0.0.1");
    }

    afterEach(async () => {
        await server.close();
    });

    it("Responds 200 with the value on a found lookup.", async () => {
        await start(async () => ({ found: true, value: "example.com" }));
        const response = await sendLine(port, "get example.com");
        expect(response).toBe("200 example.com");
    });

    it("Responds 500 (permanent) on a definitive not-found lookup.", async () => {
        await start(async () => ({ found: false }));
        const response = await sendLine(port, "get nobody@example.com");
        expect(response).toBe("500 not%20found");
    });

    it("Responds 400 (temporary) when the lookup explicitly signals a temporary failure.", async () => {
        await start(async () => ({ found: false, temporary: true }));
        const response = await sendLine(port, "get example.com");
        expect(response).toBe("400 not%20found");
    });

    it("Responds 400 when the lookup callback throws.", async () => {
        await start(async () => {
            throw new Error("upstream unreachable");
        });
        const response = await sendLine(port, "get example.com");
        expect(response).toBe("400 upstream%20unreachable");
    });

    it("Responds 400 with a generic message when the lookup callback throws a value with no message.", async () => {
        await start(async () => {
            // eslint-disable-next-line no-throw-literal
            throw { code: "ECONNRESET" };
        });
        const response = await sendLine(port, "get example.com");
        expect(response).toBe("400 internal%20error");
    });

    it("Percent-decodes the request key before passing it to the lookup callback.", async () => {
        let receivedKey: string | undefined;
        await start(async (key) => {
            receivedKey = key;
            return { found: true, value: "ok" };
        });
        await sendLine(port, "get user%2Btag@example.com");
        expect(receivedKey).toBe("user+tag@example.com");
    });

    it("Percent-encodes a response value containing reserved characters.", async () => {
        await start(async () => ({ found: true, value: "10 mail.example.com" }));
        const response = await sendLine(port, "get example.com");
        expect(response).toBe("200 10%20mail.example.com");
    });

    it("Responds 400 for an unsupported command.", async () => {
        await start(async () => ({ found: true, value: "x" }));
        const response = await sendLine(port, "put example.com value");
        expect(response).toBe("400 unsupported%20command");
    });

    it("Responds 400 for a get with no key.", async () => {
        await start(async () => ({ found: true, value: "x" }));
        const response = await sendLine(port, "get");
        expect(response).toBe("400 missing%20key");
    });

    it("Skips handling a queued line if the socket was already destroyed by the time it's dequeued.", async () => {
        const lookupMock = vi.fn();
        await start(lookupMock);
        const fakeSocket = { destroyed: true, write: vi.fn() } as unknown as net.Socket;

        await (server as unknown as { handleLine: (socket: net.Socket, line: string) => Promise<void> }).handleLine(
            fakeSocket,
            "get example.com",
        );

        expect(lookupMock).not.toHaveBeenCalled();
        expect(fakeSocket.write).not.toHaveBeenCalled();
    });

    it("Swallows a socket error event without crashing (e.g. a client disconnecting abruptly).", async () => {
        await start(async () => ({ found: true, value: "x" }));
        // handleConnection()'s own `socket.on("error", () => {})` is attached synchronously as part of the
        // "connection" event - registering another "connection" listener here (net.createServer's own
        // callback argument is itself just sugar for `.on("connection", callback)`, so this runs alongside
        // it, not instead of it) lets this test synthesize a socket error deterministically instead of
        // racing a real abrupt disconnect.
        const socketErrored = new Promise<void>((resolve) => {
            (server as any).server.on("connection", (socket: net.Socket) => {
                socket.emit("error", new Error("ECONNRESET"));
                resolve();
            });
        });

        const client = net.createConnection({ port, host: "127.0.0.1" });
        await new Promise<void>((resolve) => client.once("connect", resolve));
        await socketErrored;
        client.destroy();
    });

    it("Rejects close() if the underlying net.Server reports an error while closing.", async () => {
        await start(async () => ({ found: true, value: "x" }));
        const closeError = new Error("boom");
        // `mockImplementationOnce` only intercepts this one call - afterEach's own `server.close()` still
        // closes the real server normally afterward.
        vi.spyOn((server as any).server, "close").mockImplementationOnce((cb: (err?: Error) => void) => cb(closeError));

        await expect(server.close()).rejects.toThrow("boom");
    });

    it("Processes multiple sequential requests on the same connection.", async () => {
        const seen: string[] = [];
        await start(async (key) => {
            seen.push(key);
            return { found: true, value: key };
        });

        const responses = await new Promise<string[]>((resolve, reject) => {
            const socket = net.createConnection({ port, host: "127.0.0.1" }, () => {
                socket.write("get a.com\nget b.com\n");
            });
            socket.setEncoding("utf-8");
            let buffer = "";
            const lines: string[] = [];
            socket.on("data", (chunk: string) => {
                buffer += chunk;
                let idx: number;
                while ((idx = buffer.indexOf("\n")) >= 0) {
                    lines.push(buffer.slice(0, idx));
                    buffer = buffer.slice(idx + 1);
                    if (lines.length === 2) {
                        socket.end();
                        resolve(lines);
                    }
                }
            });
            socket.on("error", reject);
        });

        expect(responses).toEqual(["200 a.com", "200 b.com"]);
        expect(seen).toEqual(["a.com", "b.com"]);
    });
});
