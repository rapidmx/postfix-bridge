///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
// Guards how the shipped Postfix configuration (the Helm chart and docker-compose.yml) routes mail to this bridge. It reads
// those files as text: the routing itself was proven against a real Postfix in a docker lab (see .claude/NOTES.md,
// 2026-09-20), which no unit test can run.
//
// The bug this pins: `transport_maps = static:smtp:postfix-bridge:2525` matches EVERY recipient, so mail the RapidMX server
// sent to an external address was handed to this bridge (which reported it accepted) instead of going out by MX lookup, and
// was then dropped by the ingest as an unresolvable recipient. Only `relay_domains` destinations may go to the bridge.
import * as fs from "node:fs";

function read(path: string): string {
    return fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("Postfix routing to the bridge", () => {
    const chart = read("helm/templates/1_deployments/postfix.yaml");
    const compose = read("docker-compose.yml");
    const chartTlsPolicy = read("helm/templates/0_config/mail-tls-policy.yaml");
    const composeTlsPolicy = read("docker/postfix/tls_policy.txt");

    const chartRelay = /name: POSTFIX_relay_transport\s*\n\s*value: (\S+)/.exec(chart)?.[1];
    const composeRelay = /^\s*- POSTFIX_relay_transport=(\S+)/m.exec(compose)?.[1];

    it("Never sets transport_maps, which would send every recipient (external ones too) to the bridge.", () => {
        expect(chart).not.toMatch(/POSTFIX_transport_maps/);
        expect(compose).not.toMatch(/POSTFIX_transport_maps/);
    });

    it("Sends only relay_domains destinations to the bridge's SMTP listener, in the chart and in docker-compose.yml.", () => {
        expect(chartRelay).toBe("smtp:postfix-bridge:2525");
        expect(composeRelay).toBe("smtp:postfix-bridge:2525");
    });

    it("Keeps relay_domains and relay_recipient_maps on the bridge's tcp_table listeners.", () => {
        for (const config of [chart, compose]) {
            expect(config).toMatch(/POSTFIX_relay_domains(=|\s*\n\s*value: )tcp:postfix-bridge:10040/);
            expect(config).toMatch(/POSTFIX_relay_recipient_maps(=|\s*\n\s*value: )tcp:postfix-bridge:10041/);
        }
    });

    it("Exempts the relay_transport destination from mandatory outbound TLS under exactly the key Postfix looks up.", () => {
        // smtp_tls_policy_maps is keyed by the transport's next hop as written (no brackets, with the port), and
        // smtp_tls_security_level=encrypt would otherwise refuse the bridge, which has no TLS.
        const nexthop = chartRelay.replace(/^smtp:/, "");
        expect(chartTlsPolicy).toMatch(new RegExp(`^\\s*${nexthop}\\s+none$`, "m"));
        expect(composeTlsPolicy).toMatch(new RegExp(`^${nexthop}\\s+none$`, "m"));
    });
});
