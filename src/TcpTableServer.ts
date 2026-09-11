///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as net from "net";

/** The outcome of one `tcp_table(5)` `get` lookup - see `TcpTableServer`'s own doc comment for the
 * protocol this maps onto. */
export type TcpTableLookupResult =
    | { found: true; value: string }
    /** `temporary: true` maps to a `400` (soft failure, Postfix should retry later) instead of `500`
     * (permanent - definitively no match). Used for a lookup that couldn't be completed at all (e.g. the
     * upstream HTTP call failed/timed out), never for "checked and there's genuinely no match". */
    | { found: false; temporary?: boolean };

export type TcpTableLookup = (key: string) => Promise<TcpTableLookupResult>;

/** Percent-decodes a `tcp_table(5)` request key exactly as Postfix percent-encodes it: `%XX` where `XX`
 * is a two-digit hex byte value. Postfix only ever percent-encodes bytes outside the unreserved ASCII
 * range on the way out, so this is safe to apply unconditionally to whatever key text arrives. */
function decodeTcpTableValue(value: string): string {
    return value.replace(/%([0-9A-Fa-f]{2})/g, (_match, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/** Percent-encodes a `tcp_table(5)` response value: any byte outside the unreserved-and-printable ASCII
 * range, plus `%` and whitespace (which would otherwise be ambiguous with the response line's own
 * `<code> <text>` framing), becomes `%XX`. */
function encodeTcpTableValue(value: string): string {
    return value.replace(/[^\x21-\x7e]|[%]/g, (ch) => `%${ch.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

/**
 * A minimal server for Postfix's `tcp_table(5)` lookup protocol - the mechanism this deployment's Postfix
 * `main.cf` uses (via `relay_domains`/`relay_recipient_maps`, see docker-compose.yml) to consult this
 * app's `GET /internal/mta/domain`/`GET /internal/mta/resolve` endpoints during the SMTP conversation,
 * before ever accepting a message.
 *
 * Protocol (client == Postfix, server == this class): one request per line, `get <percent-encoded key>\n`;
 * one response per line, `<code> <percent-encoded text>\n`, where `code` is `200` (match; `text` is the
 * found value), `500` (no match - permanent), or `400` (couldn't complete the lookup - temporary, Postfix
 * retries later). Only `get` is implemented - `tcp_table(5)` also defines `put`/`delete` for lookup tables
 * that support being written to, which Postfix itself never sends when using a table only for lookups (the
 * only way this deployment uses it).
 *
 * Requests on one connection are processed strictly in order (a lookup is never started before the
 * previous one on the same connection has written its response) - `tcp_table(5)` is a synchronous
 * request/response protocol per connection, and Postfix's own client is not known to pipeline multiple
 * requests ahead of their responses on a single connection.
 *
 * @author Jean-Philippe Steinmetz
 */
export class TcpTableServer {
    private readonly server: net.Server;

    public constructor(private readonly lookup: TcpTableLookup) {
        this.server = net.createServer((socket) => this.handleConnection(socket));
    }

    /** Resolves with the actual bound port - the same value given for `port`, unless `port` was `0`, in
     * which case the OS assigned an ephemeral one (used by this class's own tests). */
    public listen(port: number, host: string = "0.0.0.0"): Promise<number> {
        return new Promise((resolve) => {
            this.server.listen(port, host, () => resolve((this.server.address() as net.AddressInfo).port));
        });
    }

    public close(): Promise<void> {
        return new Promise((resolve, reject) => this.server.close((err) => (err ? reject(err) : resolve())));
    }

    private handleConnection(socket: net.Socket): void {
        let buffer: string = "";
        // Serializes request handling on this connection - see this class's own doc comment for why.
        let queue: Promise<void> = Promise.resolve();

        socket.setEncoding("utf-8");
        socket.on("data", (chunk: string) => {
            buffer += chunk;
            let newlineIndex: number;
            while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
                const line: string = buffer.slice(0, newlineIndex).replace(/\r$/, "");
                buffer = buffer.slice(newlineIndex + 1);
                queue = queue.then(() => this.handleLine(socket, line));
            }
        });
        socket.on("error", () => {
            // A client disconnecting mid-request (or a bad TCP reset) is routine, not exceptional -
            // nothing further can be written to this socket either way.
        });
    }

    private async handleLine(socket: net.Socket, line: string): Promise<void> {
        if (socket.destroyed) {
            return;
        }

        const spaceIndex: number = line.indexOf(" ");
        const command: string = spaceIndex === -1 ? line : line.slice(0, spaceIndex);
        const rawKey: string = spaceIndex === -1 ? "" : line.slice(spaceIndex + 1);

        if (command !== "get") {
            socket.write(`400 ${encodeTcpTableValue("unsupported command")}\n`);
            return;
        }
        if (!rawKey) {
            socket.write(`400 ${encodeTcpTableValue("missing key")}\n`);
            return;
        }

        const key: string = decodeTcpTableValue(rawKey);
        try {
            const result: TcpTableLookupResult = await this.lookup(key);
            if (result.found) {
                socket.write(`200 ${encodeTcpTableValue(result.value)}\n`);
            } else {
                socket.write(`${result.temporary ? 400 : 500} ${encodeTcpTableValue("not found")}\n`);
            }
        } catch (err: any) {
            socket.write(`400 ${encodeTcpTableValue(err?.message ?? "internal error")}\n`);
        }
    }
}
