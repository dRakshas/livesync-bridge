import { defaultLoggerEnv, Logger } from "./lib/src/common/logger.ts";
import { LOG_LEVEL_DEBUG } from "./lib/src/common/logger.ts";
import { LOG_LEVEL_NOTICE, LOG_LEVEL_URGENT } from "./lib/src/common/types.ts";
import { classifyError, describeError } from "./errorClassification.ts";
import { Hub } from "./Hub.ts";
import { Config } from "./types.ts";
import { parseArgs } from "jsr:@std/cli";

const KEY = "LSB_"
defaultLoggerEnv.minLogLevel = LOG_LEVEL_DEBUG;

// Страховка (task 2026-06-02-001, item 9): один битый/нерасшифрованный документ
// (напр. неполные чанки) не должен ронять весь bridge. Логируем непойманный
// rejection громко и продолжаем работу вместо краша процесса.
//
// Правка 2026-08-01: у страховки не было собственного голоса. Она писала через
// console.error — то есть в stderr, МИМО общего журнала Logger (без отметки
// времени и уровня, фильтром по уровню не находится), стек reason'а разъезжался
// на 7 строк журнала на один отказ, а при старте не писала ничего: «страховка
// стоит и падать нечему» и «страховки нет» выглядели одинаково — никак.
let rejections = 0;
globalThis.addEventListener("unhandledrejection", (e) => {
    rejections++;
    const why = describeError(e.reason).replace(/\s+/g, " ").trim().slice(0, 300);
    Logger(
        `[bridge] UNHANDLED_REJECTION #${rejections} (класс ${classifyError(e.reason)}):`
        + ` ${why} — перехвачено страховкой, процесс продолжает работу`,
        LOG_LEVEL_URGENT);
    e.preventDefault();
});
Logger(
    `[bridge] CRASH_GUARD_ARMED: страховка от непойманных rejection'ов установлена;`
    + ` отказ придёт в этот же журнал строкой «UNHANDLED_REJECTION #N» с классом и причиной`,
    LOG_LEVEL_NOTICE);
const configFile = Deno.env.get(`${KEY}CONFIG`) || "./dat/config.json";

console.log("LiveSync Bridge is now starting...");
let config: Config = { peers: [] };
const flags = parseArgs(Deno.args, {
    boolean: ["reset"],
    // string: ["version"],
    default: { reset: false },
});
if (flags.reset) {
    localStorage.clear();
}
try {
    const confText = await Deno.readTextFile(configFile);
    config = JSON.parse(confText);
} catch (ex) {
    console.error("Could not parse configuration!");
    console.error(ex);
}
console.log("LiveSync Bridge is now started!");
const hub = new Hub(config);
hub.start();