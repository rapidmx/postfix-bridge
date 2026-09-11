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
