///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

/** Default per-call timeout (ms) for every upstream HTTP call this client makes - see the constructor's
 * `timeoutMs` doc for why this exists at all. */
export const DEFAULT_MTA_INGEST_TIMEOUT_MS = 10_000;

/**
 * Percent-encodes an envelope address (`MAIL FROM`/`RCPT TO`) for safe transport as an HTTP header value.
 *
 * This closes two problems at once. First, `deliver()` joins multiple `RCPT TO` addresses into one
 * `X-Envelope-To` header with `,` as the separator, but RFC 5321 permits a literal comma inside a quoted
 * local part (e.g. `"a,b"@example.com`), and `smtp-server`'s own address parser does only "permissive
 * validation" - it accepts that address unchanged, quotes and comma included. An unescaped comma there
 * would make the joined header ambiguous to split back apart correctly on the receiving end. Second, RFC
 * 6531 (SMTPUTF8) legally allows non-ASCII UTF-8 bytes in the local part, which would otherwise be written
 * directly into an HTTP header value - `encodeURIComponent` keeps every header byte within the
 * safe/printable ASCII range `fetch`/undici require.
 *
 * `encodeURIComponent` (already used by `checkDomain()`/`resolveRecipient()` below for the same reason, as
 * a query-string value) is deliberately preferred here over `TcpTableServer`'s own `encodeTcpTableValue` -
 * that helper encodes by UTF-16 code unit (`charCodeAt`), which is correct for `tcp_table(5)`'s own
 * byte-oriented wire format but would mis-encode a multi-byte UTF-8 character as a single `%XX` here.
 *
 * NOTE: the receiving end (`@rapidmx/restapi`'s `BaseMailIngestRoute.deliver()`) currently splits
 * `X-Envelope-To` on a bare `,` and uses each segment as the literal address - it does not yet
 * `decodeURIComponent` its segments. That companion fix belongs to that repo; until it lands, this change
 * guarantees the *count* of recipients survives a comma-containing address intact (no extra, garbled
 * recipient is synthesized), which is the security-relevant half of this fix, without regressing what the
 * plain, common case (no reserved characters) looks like on the wire.
 */
function encodeEnvelopeAddress(address: string): string {
    return encodeURIComponent(address);
}

/**
 * Thin HTTP client for the `MTAIngestAdapter` contract this bridge translates Postfix's `tcp_table`/SMTP
 * protocols into - see `@rapidmx/restapi`'s `src/transport/MTAIngestAdapter.ts` for the authoritative
 * contract (`GET /internal/mta/domain`, `GET /internal/mta/resolve`, `POST /internal/mta/deliver`), which
 * this class is deliberately kept in lockstep with. Talks over plain HTTP within the compose/cluster
 * network - the bearer secret, not TLS, is this contract's stated security boundary (see
 * `BaseMailIngestRoute.authorizeInternalCaller()`).
 *
 * @author Jean-Philippe Steinmetz
 */
export class MtaIngestClient {
    public constructor(
        private readonly baseUrl: string,
        private readonly secret: string,
        /** Every `fetch()` call below aborts after this many milliseconds. `TcpTableServer` serializes
         * lookups per Postfix-held connection (see that class's own doc comment), so a hung upstream call
         * with no timeout would stall every queued lookup on that connection indefinitely; a hung
         * `deliver()` call would do the same to `SmtpDeliveryServer`'s own in-flight SMTP transaction.
         * Deliberately not caught/mapped here - `fetch`'s own `TimeoutError` rejection propagates exactly
         * like any other network failure to the callers that already translate a thrown error into
         * Postfix's `400`/`450` "temporary failure, retry later" convention (`TcpTableServer.handleLine()`,
         * `SmtpDeliveryServer.handleData()`). */
        private readonly timeoutMs: number = DEFAULT_MTA_INGEST_TIMEOUT_MS,
    ) {}

    private authHeader(): Record<string, string> {
        return { Authorization: `Bearer ${this.secret}` };
    }

    /** `GET /internal/mta/domain?name=<domain>` - `true` if this deployment accepts/relays mail for
     * `domain` at all. Throws on anything other than a definitive 200/404 (a temporary failure, so the
     * caller can map it to a `tcp_table` `400` rather than a false `500` permanent rejection). */
    public async checkDomain(domain: string): Promise<boolean> {
        const res: Response = await fetch(`${this.baseUrl}/domain?name=${encodeURIComponent(domain)}`, {
            headers: this.authHeader(),
            signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (res.status === 200) {
            return true;
        }
        if (res.status === 404) {
            return false;
        }
        throw new Error(`Unexpected status ${res.status} checking domain '${domain}'`);
    }

    /** `GET /internal/mta/resolve?rcpt=<address>` - `true` if `address` resolves to a mailbox or
     * distribution list. Same temporary-vs-permanent failure semantics as `checkDomain()`. */
    public async resolveRecipient(address: string): Promise<boolean> {
        const res: Response = await fetch(`${this.baseUrl}/resolve?rcpt=${encodeURIComponent(address)}`, {
            headers: this.authHeader(),
            signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (res.status === 200) {
            return true;
        }
        if (res.status === 404) {
            return false;
        }
        throw new Error(`Unexpected status ${res.status} resolving recipient '${address}'`);
    }

    /** `POST /internal/mta/deliver` - hands off one accepted SMTP transaction's raw message plus its
     * envelope. Throws unless the response is `202` (accepted for async processing - see
     * `BaseMailIngestRoute.deliver()`'s own doc comment), so the caller can translate a failure into the
     * right SMTP rejection code back to the original sending MTA. */
    public async deliver(envelopeFrom: string, envelopeTo: string[], raw: Buffer): Promise<void> {
        const res: Response = await fetch(`${this.baseUrl}/deliver`, {
            method: "POST",
            headers: {
                ...this.authHeader(),
                "Content-Type": "message/rfc822",
                "X-Envelope-From": encodeEnvelopeAddress(envelopeFrom),
                "X-Envelope-To": envelopeTo.map(encodeEnvelopeAddress).join(","),
            },
            // Node's fetch (undici) accepts a `Buffer` body at runtime - this project's `BodyInit` typing
            // just doesn't model that, hence the cast.
            body: raw as unknown as BodyInit,
            signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (res.status !== 202) {
            const body: string = await res.text().catch(() => "");
            throw new Error(`Unexpected status ${res.status} delivering message: ${body}`);
        }
    }
}
