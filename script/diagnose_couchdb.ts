/**
 * Diagnostic script for livesync-bridge (задача 2026-06-07-002, шаг 3).
 *
 * Подключается к CouchDB, пытается расшифровать каждый note-документ
 * через тот же DirectFileManipulator, что использует bridge, и выводит
 * список ID, на которых дешифровка падает (UNREADABLE_DOC).
 *
 * ВАЖНО: запускать ТОЛЬКО при остановленном bridge — иначе диагностика гонится
 * с живыми put'ами и может ложно пометить незавершённую ревизию «нечитаемой».
 * Скрипт НЕ удаляет и НЕ модифицирует никакие документы (см. ограничения PR).
 *
 * Конфигурация (по приоритету):
 *   1. CLI флаги:  --url --user --password --db --passphrase --obfuscate
 *   2. ENV:        LSB_CONFIG=<path> (берёт первый couchdb-peer из конфига)
 *   3. ENV:        TSIP / COUCHDB_USER / COUCHDB_PASSWORD / COUCHDB_DB /
 *                  LIVESYNC_E2E_PASSPHRASE (формат /root/.config/couchdb-livesync/credentials.env)
 *
 * Запуск:
 *   deno run -A script/diagnose_couchdb.ts --peer <name>
 *   --env-file=/root/.config/couchdb-livesync/credentials.env deno run -A script/diagnose_couchdb.ts
 */

import { parseArgs } from "jsr:@std/cli";
import { DirectFileManipulator } from "../lib/src/API/DirectFileManipulatorV2.ts";
import type { PeerCouchDBConf, Config } from "../types.ts";
import { classifyError, describeError } from "../errorClassification.ts";

type CouchDBConn = {
    url: string;
    username: string;
    password: string;
    database: string;
    passphrase: string;
    obfuscatePassphrase: string;
};

function envConn(): CouchDBConn | null {
    const tsip = Deno.env.get("TSIP");
    const user = Deno.env.get("COUCHDB_USER");
    const pass = Deno.env.get("COUCHDB_PASSWORD");
    const db = Deno.env.get("COUCHDB_DB");
    const passphrase = Deno.env.get("LIVESYNC_E2E_PASSPHRASE");
    if (!tsip || !user || !pass || !db || !passphrase) return null;
    const port = Deno.env.get("COUCHDB_PORT") ?? "5984";
    const scheme = Deno.env.get("COUCHDB_SCHEME") ?? "http";
    const obf = Deno.env.get("LIVESYNC_OBFUSCATE_PASSPHRASE") ?? passphrase;
    return {
        url: `${scheme}://${tsip}:${port}`,
        username: user,
        password: pass,
        database: db,
        passphrase,
        obfuscatePassphrase: obf,
    };
}

async function configConn(configPath: string, peerName?: string): Promise<CouchDBConn | null> {
    const text = await Deno.readTextFile(configPath);
    const conf = JSON.parse(text) as Config;
    const couch = conf.peers.find((p): p is PeerCouchDBConf => p.type === "couchdb" && (!peerName || p.name === peerName));
    if (!couch) return null;
    return {
        url: couch.url,
        username: couch.username,
        password: couch.password,
        database: couch.database,
        passphrase: couch.passphrase,
        obfuscatePassphrase: couch.obfuscatePassphrase,
    };
}

async function listAllIds(conn: CouchDBConn): Promise<string[]> {
    const auth = "Basic " + btoa(`${conn.username}:${conn.password}`);
    const url = `${conn.url.replace(/\/+$/, "")}/${conn.database}/_all_docs`;
    const resp = await fetch(url, { headers: { Authorization: auth } });
    if (!resp.ok) {
        throw new Error(`_all_docs HTTP ${resp.status}: ${await resp.text()}`);
    }
    const body = await resp.json() as { rows: { id: string }[] };
    return body.rows.map((r) => r.id);
}

async function main() {
    const flags = parseArgs(Deno.args, {
        string: ["url", "user", "password", "db", "passphrase", "obfuscate", "peer", "config"],
        boolean: ["verbose"],
        default: { config: Deno.env.get("LSB_CONFIG") ?? "./dat/config.json" },
    });

    let conn: CouchDBConn | null = null;
    if (flags.url && flags.user && flags.password && flags.db && flags.passphrase) {
        conn = {
            url: flags.url,
            username: flags.user,
            password: flags.password,
            database: flags.db,
            passphrase: flags.passphrase,
            obfuscatePassphrase: flags.obfuscate ?? flags.passphrase,
        };
    }
    if (!conn) {
        try {
            conn = await configConn(flags.config!, flags.peer);
        } catch (ex) {
            if (flags.verbose) console.error(`config load failed: ${describeError(ex)}`);
        }
    }
    if (!conn) conn = envConn();
    if (!conn) {
        console.error(
            "ERROR: no connection info. Provide --url/--user/--password/--db/--passphrase, " +
            "or a config file with a couchdb peer, or env vars (TSIP/COUCHDB_USER/COUCHDB_PASSWORD/COUCHDB_DB/LIVESYNC_E2E_PASSPHRASE).",
        );
        Deno.exit(2);
    }

    console.error(`Connecting to ${conn.url}/${conn.database} as ${conn.username}`);
    console.error("Reminder: bridge должен быть остановлен на время диагностики.");

    const man = new DirectFileManipulator({
        url: conn.url,
        username: conn.username,
        password: conn.password,
        database: conn.database,
        passphrase: conn.passphrase,
        obfuscatePassphrase: conn.obfuscatePassphrase,
    });
    await man.ready.promise;

    const ids = await listAllIds(conn);
    console.error(`Found ${ids.length} documents. Probing decryption…`);

    const unreadable: { id: string; reason: string }[] = [];
    let probedNotes = 0;
    let nonNote = 0;
    let otherErrors = 0;

    for (const id of ids) {
        if (id.startsWith("_design/")) {
            nonNote++;
            continue;
        }
        try {
            const result = await man.getById(id);
            if (result === false) {
                nonNote++;
            } else {
                probedNotes++;
            }
        } catch (ex) {
            const cls = classifyError(ex);
            const reason = describeError(ex);
            if (cls === "decryption") {
                unreadable.push({ id, reason });
                console.error(`UNREADABLE_DOC: ${id} — ${reason}`);
            } else {
                otherErrors++;
                if (flags.verbose) {
                    console.error(`other-error (${cls}) on ${id}: ${reason}`);
                }
            }
        }
    }

    console.error("---");
    console.error(`Probed notes:      ${probedNotes}`);
    console.error(`Non-note skipped:  ${nonNote}`);
    console.error(`Other errors:      ${otherErrors}`);
    console.error(`UNREADABLE total:  ${unreadable.length}`);

    // Машиночитаемый список ID на stdout (для пайпа дальше).
    for (const row of unreadable) {
        console.log(row.id);
    }
}

main().catch((ex) => {
    console.error("FATAL:", describeError(ex));
    Deno.exit(1);
});
