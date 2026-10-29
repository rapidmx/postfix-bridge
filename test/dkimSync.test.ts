///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
// Runs the chart's dkim-sync.sh (the watcher that keeps OpenDKIM in step with the DKIM keys the RapidMX server writes, see
// helm/templates/0_config/mail-tls-policy.yaml) for real, with bash, against temporary directories standing in for the shared
// DKIM volume, OpenDKIM's keys and its tables. Only the three commands that need the Postfix image are stubbed: `pkill` and
// `pgrep` (OpenDKIM running or not), `install` (the image's opendkim user, which a test machine doesn't have, and a failing
// install) and `sleep` (stopping the watcher after a number of passes).
//
// What this pins (restapi specs/dns_publishing_and_integrations.md, 6.2): each domain is signed with the selector the server wrote
// to <domain>.selector, else the global DKIM_SELECTOR, keeping the key it moved off until the server deletes it; and
// <domain>.signing, which the server's DKIM rotation waits for before it starts the overlap, is written only once a running
// OpenDKIM has had a pass to reload the tables naming that selector.
import * as child_process from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function read(file: string): string {
    return fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
}

/** The value of a `key: |` block scalar in the mail-tls-policy ConfigMap, as the pod sees the mounted file. */
function configMapFile(key: string): string {
    const lines: string[] = read("helm/templates/0_config/mail-tls-policy.yaml").split(/\r?\n/);
    const start: number = lines.indexOf(`  ${key}: |`);
    expect(start).toBeGreaterThanOrEqual(0);
    const body: string[] = [];
    for (const line of lines.slice(start + 1)) {
        if (line.trim() !== "" && !line.startsWith("    ")) {
            break;
        }
        body.push(line.slice(4));
    }
    return body.join("\n").trimEnd() + "\n";
}

/** Git for Windows' bash on a Windows machine (the one on PATH there may be WSL's), else the system's. */
function findBash(): string {
    const gitBash: string = "C:\\Program Files\\Git\\bin\\bash.exe";
    return process.platform === "win32" && fs.existsSync(gitBash) ? gitBash : "bash";
}

function slash(file: string): string {
    return file.replace(/\\/g, "/");
}

const STUBS: Record<string, string> = {
    // OpenDKIM is "running" while $FAKE_OPENDKIM is. A delivered signal is logged with the acknowledgements present at that moment.
    pkill: `#!/bin/bash
[ "$FAKE_OPENDKIM" = running ] || exit 1
echo "pkill $* acks=$(cd "$DKIM_SOURCE_DIR" && ls *.signing 2>/dev/null | tr '\\n' ' ')" >> "$FAKE_LOG"
`,
    pgrep: `#!/bin/bash
echo "pgrep $*" >> "$FAKE_LOG"
[ "$FAKE_OPENDKIM" = running ]
`,
    // The watcher sleeps after each whole pass: it is stopped there after $FAKE_PASSES of them.
    sleep: `#!/bin/bash
echo "sleep $*" >> "$FAKE_LOG"
[ "$(grep -c '^sleep' "$FAKE_LOG")" -ge "$FAKE_PASSES" ] && kill -TERM "$PPID"
exit 0
`,
    // The real install, without -o/-g/-m, which are logged instead: there is no opendkim user here, and Git for Windows' install
    // can't set a directory's mode.
    install: `#!/bin/bash
[ -n "$FAKE_INSTALL_FAIL" ] && exit 1
args=()
while [ $# -gt 0 ]; do
  case "$1" in
    -o|-g|-m) echo "install $1 $2" >> "$FAKE_LOG"; shift 2 ;;
    *) args+=("$1"); shift ;;
  esac
done
exec /usr/bin/install "\${args[@]}"
`,
};

// Counts the commands a pass starts that the script can do without (see "Cost of a pass"): each logs itself to $FAKE_FORKS, then runs
// the real one from the rest of the PATH (the stubs directory is first).
for (const name of ["openssl", "head", "tr", "basename", "dirname", "rm", "cmp"]) {
    STUBS[name] = `#!/bin/bash
echo "\${0##*/}" >> "$FAKE_FORKS"
PATH="\${PATH#*:}" exec "\${0##*/}" "$@"
`;
}

/** Whether this machine lets the tests make symbolic links (Windows doesn't without Developer Mode; CI's Linux does). */
function canSymlink(): boolean {
    const dir: string = fs.mkdtempSync(path.join(os.tmpdir(), "dkim-sync-link-"));
    try {
        fs.symlinkSync(path.join(dir, "target"), path.join(dir, "link"));
        return true;
    } catch {
        return false;
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

function newKey(): string {
    return crypto.generateKeyPairSync("rsa", {
        modulusLength: 1024,
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
        publicKeyEncoding: { type: "spki", format: "pem" },
    }).privateKey;
}

interface Run {
    status: number | null;
    stdout: string;
    stderr: string;
    log: string[];
    /** The commands of the counted kind the pass started, in order. */
    forks: string[];
}

// Each pass starts bash and openssl, which is slow on Windows.
describe("dkim-sync.sh", { timeout: 60_000 }, () => {
    const bash: string = findBash();
    const symlinks: boolean = canSymlink();
    let root: string;
    let src: string;
    let keys: string;
    let tables: string;
    let script: string;
    let stubs: string;
    let fakeLog: string;
    let fakeForks: string;

    beforeEach(() => {
        root = slash(fs.mkdtempSync(path.join(os.tmpdir(), "dkim-sync-")));
        src = `${root}/src`;
        keys = `${root}/keys`;
        tables = `${root}/tables`;
        stubs = `${root}/bin`;
        script = `${root}/dkim-sync.sh`;
        fakeLog = `${root}/fake.log`;
        fakeForks = `${root}/forks.log`;
        for (const dir of [src, keys, tables, stubs]) {
            fs.mkdirSync(dir);
        }
        fs.writeFileSync(script, configMapFile("dkim-sync.sh"));
        for (const [name, body] of Object.entries(STUBS)) {
            fs.writeFileSync(`${stubs}/${name}`, body, { mode: 0o755 });
        }
        fs.writeFileSync(fakeLog, "");
        fs.writeFileSync(fakeForks, "");
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    /** One pass (`--once`), or with `passes` the watcher itself, stopped after that many. */
    function sync(
        opendkim: "running" | "stopped",
        selector: string = "mail",
        options: { passes?: number; env?: Record<string, string> } = {}
    ): Run {
        fs.writeFileSync(fakeLog, "");
        fs.writeFileSync(fakeForks, "");
        const args: string = options.passes ? "" : " --once";
        const result = child_process.spawnSync(
            bash,
            [
                "-c",
                // Git for Windows' bash puts its own /usr/bin first, so the stubs go in front here, as a POSIX path.
                `stubs=$STUBS; if command -v cygpath >/dev/null; then stubs=$(cygpath -u "$stubs"); fi; PATH="$stubs:$PATH" exec bash "$SCRIPT"${args}`,
            ],
            {
                encoding: "utf8",
                // A script that ignores --once (or a watcher that never gets to its pgrep) would watch forever.
                timeout: 20_000,
                env: {
                    ...process.env,
                    ...options.env,
                    FAKE_PASSES: String(options.passes ?? 0),
                    STUBS: stubs,
                    SCRIPT: script,
                    DKIM_SOURCE_DIR: src,
                    DKIM_KEYS_DIR: keys,
                    DKIM_TABLE_DIR: tables,
                    DKIM_SELECTOR: selector,
                    FAKE_OPENDKIM: opendkim,
                    FAKE_LOG: fakeLog,
                    FAKE_FORKS: fakeForks,
                },
            }
        );
        return {
            status: result.status,
            stdout: result.stdout,
            stderr: result.stderr,
            log: fs.readFileSync(fakeLog, "utf8").split("\n").filter(Boolean),
            forks: fs.readFileSync(fakeForks, "utf8").split("\n").filter(Boolean),
        };
    }

    function table(name: "KeyTable" | "SigningTable"): string[] {
        return fs.readFileSync(`${tables}/${name}`, "utf8").split("\n").filter(Boolean);
    }

    function signals(run: Run): string[] {
        return run.log.filter((line) => line.startsWith("pkill "));
    }

    function acknowledged(domain: string): string | undefined {
        const file: string = `${src}/${domain}.signing`;
        return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined;
    }

    describe("Selectors", () => {
        it("Signs a domain without a <domain>.selector file with the global DKIM_SELECTOR, as before rotation existed.", () => {
            const key: string = newKey();
            fs.writeFileSync(`${src}/example.com.s1.key`, key);

            const run: Run = sync("stopped", "s1");

            expect(run.status).toBe(0);
            expect(fs.readFileSync(`${keys}/example.com/s1.private`, "utf8")).toBe(key);
            expect(table("KeyTable")).toEqual([`s1._domainkey.example.com example.com:s1:${keys}/example.com/s1.private`]);
            expect(table("SigningTable")).toEqual(["*@example.com s1._domainkey.example.com"]);
            // Readable by OpenDKIM's own user only.
            expect(run.log).toContain("install -o opendkim");
            expect(run.log).toContain("install -g opendkim");
            expect(run.log).toContain("install -m 0400");
        });

        it("Signs a domain with the selector the server wrote to <domain>.selector, and only that one.", () => {
            const oldKey: string = newKey();
            const newKeyPem: string = newKey();
            fs.writeFileSync(`${src}/example.com.mail.key`, oldKey);
            fs.writeFileSync(`${src}/example.com.rmx20261027.key`, newKeyPem);
            fs.writeFileSync(`${src}/example.com.selector`, "rmx20261027\n");

            expect(sync("stopped").status).toBe(0);

            expect(fs.readFileSync(`${keys}/example.com/rmx20261027.private`, "utf8")).toBe(newKeyPem);
            expect(fs.existsSync(`${keys}/example.com/mail.private`)).toBe(false);
            expect(table("KeyTable")).toEqual([
                `rmx20261027._domainkey.example.com example.com:rmx20261027:${keys}/example.com/rmx20261027.private`,
            ]);
            expect(table("SigningTable")).toEqual(["*@example.com rmx20261027._domainkey.example.com"]);
        });

        it("Signs each domain with its own selector: a rotated one with its new one, the others with the global one.", () => {
            fs.writeFileSync(`${src}/a.example.mail.key`, newKey());
            fs.writeFileSync(`${src}/b.example.mail.key`, newKey());
            fs.writeFileSync(`${src}/b.example.rmx20261027b.key`, newKey());
            fs.writeFileSync(`${src}/b.example.selector`, "rmx20261027b\n");
            // A selector file naming the global selector is the same as none (a cancelled switch is reverted this way).
            fs.writeFileSync(`${src}/c.example.mail.key`, newKey());
            fs.writeFileSync(`${src}/c.example.selector`, "mail\n");

            expect(sync("stopped").status).toBe(0);

            expect(table("SigningTable")).toEqual([
                "*@a.example mail._domainkey.a.example",
                "*@b.example rmx20261027b._domainkey.b.example",
                "*@c.example mail._domainkey.c.example",
            ]);
            expect(table("KeyTable")).toEqual([
                `mail._domainkey.a.example a.example:mail:${keys}/a.example/mail.private`,
                `rmx20261027b._domainkey.b.example b.example:rmx20261027b:${keys}/b.example/rmx20261027b.private`,
                `mail._domainkey.c.example c.example:mail:${keys}/c.example/mail.private`,
            ]);
        });

        it("Moves a domain to its new selector when <domain>.selector appears, keeping the old key until the server deletes it.", () => {
            const oldKey: string = newKey();
            fs.writeFileSync(`${src}/example.com.mail.key`, oldKey);
            sync("running");
            expect(fs.readFileSync(`${keys}/example.com/selector`, "utf8")).toBe("mail\n");

            fs.writeFileSync(`${src}/example.com.rmx20261027.key`, newKey());
            fs.writeFileSync(`${src}/example.com.selector`, "rmx20261027\n");
            sync("running");

            // OpenDKIM reads the key a table names each time it signs, and a session opened before the reload keeps the old
            // tables: the old key must still be there for it.
            expect(fs.readdirSync(`${keys}/example.com`).sort()).toEqual(["mail.private", "rmx20261027.private", "selector"]);
            expect(fs.readFileSync(`${keys}/example.com/mail.private`, "utf8")).toBe(oldKey);
            expect(fs.readFileSync(`${keys}/example.com/selector`, "utf8")).toBe("rmx20261027\n");
            expect(table("SigningTable")).toEqual(["*@example.com rmx20261027._domainkey.example.com"]);

            // Still there through the overlap, while the server keeps its key and record.
            sync("running");
            expect(fs.existsSync(`${keys}/example.com/mail.private`)).toBe(true);

            // The server retires it at the end of the overlap.
            fs.rmSync(`${src}/example.com.mail.key`);
            const run: Run = sync("running");

            expect(fs.readdirSync(`${keys}/example.com`).sort()).toEqual(["rmx20261027.private", "selector"]);
            expect(table("SigningTable")).toEqual(["*@example.com rmx20261027._domainkey.example.com"]);
            // The tables didn't name it: nothing to reload.
            expect(signals(run)).toEqual([]);
        });

        it("Removes a retired key only once the tables of the pass before didn't name it either.", () => {
            // A cancelled switch: the server reverts the selector and deletes the new key, possibly within one interval.
            fs.writeFileSync(`${src}/example.com.mail.key`, newKey());
            fs.writeFileSync(`${src}/example.com.rmx20261027.key`, newKey());
            fs.writeFileSync(`${src}/example.com.selector`, "rmx20261027\n");
            sync("running");

            fs.writeFileSync(`${src}/example.com.selector`, "mail\n");
            fs.rmSync(`${src}/example.com.rmx20261027.key`);
            sync("running");

            // OpenDKIM was only now asked to reload: until it has, it may still read the key.
            expect(table("SigningTable")).toEqual(["*@example.com mail._domainkey.example.com"]);
            expect(fs.existsSync(`${keys}/example.com/rmx20261027.private`)).toBe(true);

            sync("running");

            expect(fs.readdirSync(`${keys}/example.com`).sort()).toEqual(["mail.private", "selector"]);
        });

        it("Keeps the key and the acknowledgement a domain has when installing its new key fails.", () => {
            fs.writeFileSync(`${src}/example.com.mail.key`, newKey());
            sync("running");
            sync("running");
            expect(acknowledged("example.com")).toBe("mail\n");
            const keyTable: string[] = table("KeyTable");

            fs.writeFileSync(`${src}/example.com.rmx20261027.key`, newKey());
            fs.writeFileSync(`${src}/example.com.selector`, "rmx20261027\n");
            const runs: Run[] = [1, 2].map(() => sync("running", "mail", { env: { FAKE_INSTALL_FAIL: "1" } }));

            expect(runs.map((run) => run.status)).toEqual([0, 0]);
            expect(runs.flatMap(signals)).toEqual([]);
            expect(table("KeyTable")).toEqual(keyTable);
            expect(fs.readFileSync(`${keys}/example.com/selector`, "utf8")).toBe("mail\n");
            expect(fs.existsSync(`${keys}/example.com/rmx20261027.private`)).toBe(false);
            expect(acknowledged("example.com")).toBe("mail\n");
        });

        it("Keeps signing a domain the server removed, as before, but acknowledges nothing for it any more.", () => {
            // The main service's sender check already stops a removed domain sending.
            fs.writeFileSync(`${src}/example.com.mail.key`, newKey());
            sync("running");
            sync("running");
            const keyTable: string[] = table("KeyTable");

            fs.rmSync(`${src}/example.com.mail.key`);
            fs.rmSync(`${src}/example.com.signing`);
            const run: Run = sync("running");

            expect(signals(run)).toEqual([]);
            expect(table("KeyTable")).toEqual(keyTable);
            expect(fs.existsSync(`${keys}/example.com/mail.private`)).toBe(true);
            expect(acknowledged("example.com")).toBeUndefined();
        });

        it("Keeps signing with the key a domain has while its new selector's key isn't a complete key yet.", () => {
            fs.writeFileSync(`${src}/example.com.mail.key`, newKey());
            sync("stopped");

            fs.writeFileSync(`${src}/example.com.rmx20261027.key`, "-----BEGIN PRIVATE KEY-----\nMIIE");
            fs.writeFileSync(`${src}/example.com.selector`, "rmx20261027\n");
            sync("stopped");

            expect(fs.existsSync(`${keys}/example.com/rmx20261027.private`)).toBe(false);
            expect(table("SigningTable")).toEqual(["*@example.com mail._domainkey.example.com"]);
        });

        it("Ignores a <domain>.selector that isn't one lowercase DNS label, keeping the key the domain has and saying so once.", () => {
            fs.writeFileSync(`${src}/example.com.mail.key`, newKey());
            sync("stopped");
            fs.writeFileSync(`${src}/example.com.Bad_Selector.key`, newKey());
            fs.writeFileSync(`${src}/example.com.selector`, "Bad_Selector\n");

            const run: Run = sync("stopped");

            expect(run.status).toBe(0);
            expect(table("SigningTable")).toEqual(["*@example.com mail._domainkey.example.com"]);
            expect(run.stderr.match(/Bad_Selector/g)).toHaveLength(1);
        });

        it("Says so once per watcher, not on every pass.", () => {
            fs.writeFileSync(`${src}/example.com.mail.key`, newKey());
            fs.writeFileSync(`${src}/example.com.selector`, "Bad_Selector\n");

            const run: Run = sync("stopped", "mail", { passes: 3 });

            // The watcher ran three passes, then was stopped.
            expect(run.stdout).toContain("Watching");
            expect(run.log.filter((line) => line.startsWith("pgrep"))).toHaveLength(3);
            expect(run.stderr.match(/Bad_Selector/g)).toHaveLength(1);
        });

        it.skipIf(!symlinks)("Reads a <domain>.selector only when it is a plain file, not a link to one elsewhere.", () => {
            fs.writeFileSync(`${src}/example.com.mail.key`, newKey());
            fs.writeFileSync(`${src}/example.com.rmx20261027.key`, newKey());
            fs.writeFileSync(`${root}/elsewhere`, "rmx20261027\n");
            fs.symlinkSync(`${root}/elsewhere`, `${src}/example.com.selector`);

            const run: Run = sync("stopped");

            expect(run.status).toBe(0);
            expect(fs.existsSync(`${keys}/example.com`)).toBe(false);
            expect(run.stderr).toContain(`Ignoring ${src}/example.com.selector`);
        });

        it("Skips a key file whose domain part isn't a host name.", () => {
            fs.writeFileSync(`${src}/bad_domain.mail.key`, newKey());
            fs.writeFileSync(`${src}/-x.selector`, "rmx20261027\n");

            expect(sync("stopped").status).toBe(0);

            expect(table("KeyTable")).toEqual([]);
            expect(fs.readdirSync(keys)).toEqual([]);
        });

        it("Keeps <domain>.private, which the image checks at start, a copy of the key the domain is signed with.", () => {
            // Without it the image generates a key of its own on every start ("Please make sure to update your DNS records!").
            const key: string = newKey();
            fs.writeFileSync(`${keys}/example.com.private`, "the image's own key");
            fs.writeFileSync(`${keys}/example.com.txt`, "the image's own record");
            fs.writeFileSync(`${src}/example.com.mail.key`, newKey());
            fs.writeFileSync(`${src}/example.com.rmx20261027.key`, key);
            fs.writeFileSync(`${src}/example.com.selector`, "rmx20261027\n");

            sync("stopped");

            expect(fs.readFileSync(`${keys}/example.com.private`, "utf8")).toBe(key);
            expect(fs.existsSync(`${keys}/example.com.txt`)).toBe(false);
            // The copy isn't what OpenDKIM reads: the tables name the selector's own file.
            expect(table("KeyTable")).toEqual([
                `rmx20261027._domainkey.example.com example.com:rmx20261027:${keys}/example.com/rmx20261027.private`,
            ]);
        });

        it("Still signs a domain the server has no key for with a <domain>.private put there by hand, with the global selector.", () => {
            fs.writeFileSync(`${keys}/legacy.example.private`, newKey());
            fs.writeFileSync(`${src}/example.com.s1.key`, newKey());

            sync("running", "s1");

            expect(table("SigningTable")).toEqual([
                "*@example.com s1._domainkey.example.com",
                "*@legacy.example s1._domainkey.legacy.example",
            ]);
            expect(table("KeyTable")).toContain(`s1._domainkey.legacy.example legacy.example:s1:${keys}/legacy.example.private`);
            // Not the server's domain: nothing to acknowledge to it.
            expect(acknowledged("legacy.example")).toBeUndefined();
        });

        it("Neither signs with nor removes a key in a <domain>/ directory it didn't make, as the image never read those.", () => {
            fs.mkdirSync(`${keys}/legacy.example`);
            fs.writeFileSync(`${keys}/legacy.example/custom.private`, newKey());

            sync("running");
            sync("running");

            expect(table("KeyTable")).toEqual([]);
            expect(fs.readdirSync(`${keys}/legacy.example`)).toEqual(["custom.private"]);
        });
    });

    describe("Acknowledgement (<domain>.signing)", () => {
        it("Asks a running OpenDKIM to reload when the tables change, then writes <domain>.signing on the next pass.", () => {
            fs.writeFileSync(`${src}/a.example.mail.key`, newKey());
            fs.writeFileSync(`${src}/b.example.rmx20261027.key`, newKey());
            fs.writeFileSync(`${src}/b.example.selector`, "rmx20261027\n");

            const run: Run = sync("running");

            expect(run.status).toBe(0);
            expect(signals(run)).toEqual(["pkill -USR1 -x opendkim acks="]);
            // OpenDKIM reloads when it gets to it: the signal being delivered isn't yet the tables being read.
            expect(acknowledged("a.example")).toBeUndefined();
            expect(acknowledged("b.example")).toBeUndefined();

            const next: Run = sync("running");

            expect(signals(next)).toEqual([]);
            expect(acknowledged("a.example")).toBe("mail\n");
            expect(acknowledged("b.example")).toBe("rmx20261027\n");
        });

        it("Writes no acknowledgement while OpenDKIM isn't running, though the tables are written for it to read when it starts.", () => {
            fs.writeFileSync(`${src}/example.com.rmx20261027.key`, newKey());
            fs.writeFileSync(`${src}/example.com.selector`, "rmx20261027\n");

            const run: Run = sync("stopped");

            expect(signals(run)).toEqual([]);
            expect(acknowledged("example.com")).toBeUndefined();
            expect(table("SigningTable")).toEqual(["*@example.com rmx20261027._domainkey.example.com"]);
            expect(fs.readdirSync(src).filter((name) => name.includes("signing"))).toEqual([]);
        });

        it("Acknowledges unchanged tables without a reload once OpenDKIM runs, since it read them when it started.", () => {
            fs.writeFileSync(`${src}/example.com.rmx20261027.key`, newKey());
            fs.writeFileSync(`${src}/example.com.selector`, "rmx20261027\n");
            sync("stopped");

            const run: Run = sync("running");

            expect(signals(run)).toEqual([]);
            expect(run.log).toContain("pgrep -x opendkim");
            expect(acknowledged("example.com")).toBe("rmx20261027\n");
        });

        it("Acknowledges a switch to a new selector only on the pass after the reload that loads it.", () => {
            fs.writeFileSync(`${src}/example.com.mail.key`, newKey());
            sync("running");
            sync("running");
            expect(acknowledged("example.com")).toBe("mail\n");

            fs.writeFileSync(`${src}/example.com.rmx20261027.key`, newKey());
            fs.writeFileSync(`${src}/example.com.selector`, "rmx20261027\n");
            const run: Run = sync("running");

            expect(signals(run)).toEqual(["pkill -USR1 -x opendkim acks=example.com.signing "]);
            expect(acknowledged("example.com")).toBe("mail\n");

            sync("running");

            expect(acknowledged("example.com")).toBe("rmx20261027\n");
        });

        it("Acknowledges on a later pass of one watcher, with no reload in between.", () => {
            fs.writeFileSync(`${src}/example.com.rmx20261027.key`, newKey());
            fs.writeFileSync(`${src}/example.com.selector`, "rmx20261027\n");

            const run: Run = sync("running", "mail", { passes: 2 });

            expect(signals(run)).toEqual(["pkill -USR1 -x opendkim acks="]);
            expect(run.stdout).toContain("OpenDKIM signs example.com with selector rmx20261027");
            expect(acknowledged("example.com")).toBe("rmx20261027\n");
        });

        it("Keeps acknowledging the selector still in use while the new one's key isn't usable, so the server never switches early.", () => {
            fs.writeFileSync(`${src}/example.com.mail.key`, newKey());
            sync("running");
            sync("running");

            fs.writeFileSync(`${src}/example.com.rmx20261027.key`, "not a key");
            fs.writeFileSync(`${src}/example.com.selector`, "rmx20261027\n");
            const run: Run = sync("running");

            expect(signals(run)).toEqual([]);
            expect(acknowledged("example.com")).toBe("mail\n");
        });

        it("Acknowledges a reverted switch: the selector file naming the old selector again.", () => {
            fs.writeFileSync(`${src}/example.com.mail.key`, newKey());
            fs.writeFileSync(`${src}/example.com.rmx20261027.key`, newKey());
            fs.writeFileSync(`${src}/example.com.selector`, "rmx20261027\n");
            sync("running");
            sync("running");
            expect(acknowledged("example.com")).toBe("rmx20261027\n");

            fs.writeFileSync(`${src}/example.com.selector`, "mail\n");
            sync("running");
            sync("running");

            expect(acknowledged("example.com")).toBe("mail\n");
            expect(table("SigningTable")).toEqual(["*@example.com mail._domainkey.example.com"]);
        });

        it("Leaves no temporary file behind in the shared volume.", () => {
            fs.writeFileSync(`${src}/example.com.mail.key`, newKey());

            sync("running");
            sync("running");

            expect(fs.readdirSync(src).sort()).toEqual(["example.com.mail.key", "example.com.signing"]);
        });

        it.skipIf(!symlinks)("Replaces a <domain>.signing that is a link, never writing through it.", () => {
            fs.writeFileSync(`${src}/example.com.mail.key`, newKey());
            fs.writeFileSync(`${root}/elsewhere`, "not ours\n");
            fs.symlinkSync(`${root}/elsewhere`, `${src}/example.com.signing`);

            sync("running");
            sync("running");

            expect(fs.lstatSync(`${src}/example.com.signing`).isSymbolicLink()).toBe(false);
            expect(acknowledged("example.com")).toBe("mail\n");
            expect(fs.readFileSync(`${root}/elsewhere`, "utf8")).toBe("not ours\n");
        });

        it("Never writes into a <domain>.signing that is a directory, saying once that it can't acknowledge.", () => {
            fs.writeFileSync(`${src}/example.com.mail.key`, newKey());
            fs.mkdirSync(`${src}/example.com.signing`);

            sync("running");
            const run: Run = sync("running", "mail", { passes: 2 });

            expect(fs.readdirSync(`${src}/example.com.signing`)).toEqual([]);
            expect(run.stderr.match(/Couldn't record/g)).toHaveLength(1);
            expect(fs.readdirSync(src).sort()).toEqual(["example.com.mail.key", "example.com.signing"]);
        });
    });

    describe("Cost of a pass", () => {
        // Every pass runs for every domain, every DKIM_SYNC_INTERVAL seconds, next to Postfix and OpenDKIM on the node: a pass over
        // domains that haven't changed must cost no more than the two cmp each, not a process per word read or path split, nor an openssl.
        it("Starts no openssl, head, tr, basename or dirname on a pass that changes nothing, however many domains there are.", () => {
            const domains: string[] = ["a.example.com", "b.example.com", "c.example.com", "d.example.com"];
            const key: string = newKey();
            for (const d of domains) {
                fs.writeFileSync(`${src}/${d}.mail.key`, key);
            }
            fs.writeFileSync(`${src}/b.example.com.rmx1.key`, key);
            fs.writeFileSync(`${src}/b.example.com.selector`, "rmx1\n");

            const first: Run = sync("running");
            expect(first.forks).toContain("openssl");
            const tablesBefore: string = table("KeyTable").join("\n");

            // The second pass writes the acknowledgements; the third has nothing left to do.
            sync("running");
            const second: Run = sync("running");

            expect(second.status).toBe(0);
            expect(second.stdout).toBe("");
            expect(table("KeyTable").join("\n")).toBe(tablesBefore);
            // The one rm is the pass's own, for the two temporary tables.
            expect(second.forks.filter((cmd) => cmd !== "cmp")).toEqual(["rm"]);
            // The key of a domain that hasn't changed isn't checked again; and cmp stays at the two a domain's copies need, plus the tables.
            expect(second.forks.filter((cmd) => cmd === "cmp").length).toBeLessThanOrEqual(domains.length * 2 + 2);
        });

        it("Still checks a key that changed, and keeps the domain's key when the new one isn't a key.", () => {
            fs.writeFileSync(`${src}/example.com.mail.key`, newKey());
            sync("running");
            const installed: string = fs.readFileSync(`${keys}/example.com/mail.private`, "utf8");

            fs.writeFileSync(`${src}/example.com.mail.key`, "half a key");
            const run: Run = sync("running");

            expect(run.forks).toContain("openssl");
            expect(fs.readFileSync(`${keys}/example.com/mail.private`, "utf8")).toBe(installed);
        });
    });

    describe("Wiring in the chart", () => {
        const postfix: string = read("helm/templates/1_deployments/postfix.yaml");

        it("Runs one pass in the dkim-keys-sync init container, from the shared volume into OpenDKIM's keys.", () => {
            const init: string = postfix.slice(postfix.indexOf("- name: dkim-keys-sync"), postfix.indexOf("containers:\n"));
            expect(init).toMatch(/bash\s*\n\s*- \/opt\/postfix-bridge\/dkim-sync\.sh\s*\n\s*- --once/);
            expect(init).toMatch(/name: DKIM_SOURCE_DIR\s*\n\s*value: \/dkim-keys/);
            expect(init).toMatch(/name: DKIM_KEYS_DIR\s*\n\s*value: \/opendkim-keys/);
            expect(init).toMatch(/name: DKIM_SELECTOR\s*\n\s*value: \{\{ \$\.Values\.dkim\.selector \| quote \}\}/);
            expect(init).toMatch(/mountPath: \/opt\/postfix-bridge\/dkim-sync\.sh\s*\n\s*subPath: dkim-sync\.sh/);
        });

        it("Runs one pass before OpenDKIM starts, so it never starts with the image's tables, then the watcher.", () => {
            const init: string = configMapFile("opendkim.sh");
            const once: number = init.indexOf("bash /opt/postfix-bridge/dkim-sync.sh --once");
            expect(once).toBeGreaterThanOrEqual(0);
            expect(init.indexOf("command         = /bin/bash /opt/postfix-bridge/dkim-sync.sh\n")).toBeGreaterThan(once);
        });
    });
});
