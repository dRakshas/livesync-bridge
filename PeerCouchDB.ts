import { DirectFileManipulator, FileInfo, MetaEntry, ReadyEntry } from "./lib/src/API/DirectFileManipulatorV2.ts";
import { FilePathWithPrefix, LOG_LEVEL_NOTICE, LOG_LEVEL_URGENT, LOG_LEVEL_VERBOSE, MILESTONE_DOCID, TweakValues } from "./lib/src/common/types.ts";
import { PeerCouchDBConf, FileData } from "./types.ts";
import { decodeBinary } from "./lib/src/string_and_binary/convert.ts";
import { isPlainText } from "./lib/src/string_and_binary/path.ts";
import { DispatchFun, Peer } from "./Peer.ts";
import { createBinaryBlob, createTextBlob, delay, isDocContentSame, unique } from "./lib/src/common/utils.ts";
import { Logger } from "./lib/src/common/logger.ts";
import { classifyError, describeError } from "./errorClassification.ts";

// Retry parameters: per задаче 2026-06-07-002 — 3 попытки × 30с только для transient
// (сеть/таймаут). DecryptionError ретраить НЕЛЬЗЯ (битые данные не починятся).
// Перед каждой попыткой делаем свежий GET за актуальным _rev (иначе 409-loop сжёг бы все попытки).
const PUT_MAX_ATTEMPTS = 3;
const PUT_RETRY_DELAY_MS = 30_000;

// export class PeerInstance()

export class PeerCouchDB extends Peer {
    man: DirectFileManipulator;
    declare config: PeerCouchDBConf;
    constructor(conf: PeerCouchDBConf, dispatcher: DispatchFun) {
        super(conf, dispatcher);
        this.man = new DirectFileManipulator(conf);
        // Fetch remote since.
        this.man.since = this.getSetting("since") || "now";
    }
    async delete(pathSrc: string): Promise<boolean> {
        const path = this.toLocalPath(pathSrc);
        if (await this.isRepeating(pathSrc, false)) {
            return false;
        }
        const r = await this.man.delete(path);
        if (r) {
            this.receiveLog(` ${path} deleted`);
        } else {
            this.receiveLog(` ${path} delete failed`, LOG_LEVEL_NOTICE);
        }
        return r;
    }
    async put(pathSrc: string, data: FileData): Promise<boolean> {
        const path = this.toLocalPath(pathSrc);
        if (await this.isRepeating(pathSrc, data)) {
            return false;
        }
        const type = isPlainText(path) ? "plain" : "newnote";
        const info: FileInfo = {
            ctime: data.ctime,
            mtime: data.mtime,
            size: data.size
        };
        const saveData = (data.data instanceof Uint8Array) ? createBinaryBlob(data.data) : createTextBlob(data.data);

        let lastError: unknown;
        for (let attempt = 1; attempt <= PUT_MAX_ATTEMPTS; attempt++) {
            try {
                // Свежий GET за актуальным _rev перед КАЖДОЙ попыткой —
                // иначе concurrent-обновление с другого устройства даст 409 на всех 3.
                const old = await this.man.get(path as FilePathWithPrefix, true) as false | MetaEntry;
                if (old && Math.abs(this.compareDate(info, old)) < 3600) {
                    try {
                        const oldDoc = await this.man.getByMeta(old);
                        if (oldDoc && ("data" in oldDoc)) {
                            const d = oldDoc.type == "plain" ? createTextBlob(oldDoc.data) : createBinaryBlob(new Uint8Array(decodeBinary(oldDoc.data)));
                            if (await isDocContentSame(d, saveData)) {
                                this.normalLog(` Skipped (Same) ${path} `);
                                return false;
                            }
                        }
                    } catch (ex) {
                        // Битый/нерасшифрованный СТАРЫЙ документ (напр. неполные чанки) — это лишь
                        // dedup-оптимизация (skip-if-same). НЕ валим put на одном документе:
                        // пропускаем сравнение и перезаписываем актуальной версией ниже.
                        this.receiveLog(` ${path} dedup-check skipped (corrupted old doc): ${describeError(ex)}`, LOG_LEVEL_NOTICE);
                    }
                }
                const r = await this.man.put(path, saveData, info, type);
                if (r) {
                    this.receiveLog(` ${path} saved`);
                } else {
                    this.receiveLog(` ${path} ignored`);
                }
                return r;
            } catch (ex) {
                lastError = ex;
                const cls = classifyError(ex);
                if (cls === "decryption") {
                    // Битые данные ретраить бесполезно — это симптом нечитаемого документа.
                    this.receiveLog(`UNREADABLE_DOC: ${path} — ${describeError(ex)}`, LOG_LEVEL_NOTICE);
                    return false;
                }
                if (cls === "unexpected") {
                    // TypeError/ReferenceError — реальный баг кода, не глотаем тихо.
                    this.receiveLog(`CRITICAL put error for ${path} — ${describeError(ex)}`, LOG_LEVEL_URGENT);
                    Logger(ex, LOG_LEVEL_VERBOSE);
                    return false;
                }
                // transient: сеть/таймаут/конфликт — ретраим со свежим _rev.
                this.receiveLog(`${path} transient put error (attempt ${attempt}/${PUT_MAX_ATTEMPTS}): ${describeError(ex)}`, LOG_LEVEL_NOTICE);
                if (attempt < PUT_MAX_ATTEMPTS) {
                    await delay(PUT_RETRY_DELAY_MS);
                }
            }
        }
        this.receiveLog(`LOST_TASK: ${path} — gave up after ${PUT_MAX_ATTEMPTS} transient failures: ${describeError(lastError)}`, LOG_LEVEL_URGENT);
        return false;
    }
    async get(pathSrc: FilePathWithPrefix): Promise<false | FileData> {
        const path = this.toLocalPath(pathSrc) as FilePathWithPrefix;
        const ret = await this.man.get(path) as false | ReadyEntry;
        if (ret === false) {
            return false;
        }
        return {
            ctime: ret.ctime,
            mtime: ret.mtime,
            data: ret.type == "newnote" ? new Uint8Array(decodeBinary(ret.data)) : ret.data,
            size: ret.size,
            deleted: ret.deleted
        };
    }
    async getMeta(pathSrc: FilePathWithPrefix): Promise<false | FileData> {
        const path = this.toLocalPath(pathSrc) as FilePathWithPrefix;
        const ret = await this.man.get(path, true) as false | MetaEntry;
        if (ret === false) {
            return false;
        }
        return {
            ctime: ret.ctime,
            mtime: ret.mtime,
            data: [],
            size: ret.size,
            deleted: ret.deleted
        };
    }
    async start(): Promise<void> {
        const baseDir = this.toLocalPath("");
        await this.man.ready.promise;
        const w = await this.man.rawGet<Record<string, any>>(MILESTONE_DOCID);
        if (w && "tweak_values" in w) {
            if (this.config.useRemoteTweaks) {
                const tweaks = Object.values(w["tweak_values"])[0] as TweakValues;
                // console.log(tweaks)
                const orgConf = { ...this.config } as Record<string, any>;
                this.config.customChunkSize = tweaks.customChunkSize ?? this.config.customChunkSize;
                this.config.minimumChunkSize = tweaks.minimumChunkSize ?? this.config.minimumChunkSize;
                if (tweaks.encrypt && !this.config.passphrase) {
                    throw new Error("Remote database is encrypted but no passphrase provided.");
                }
                if (tweaks.usePathObfuscation && !this.config.obfuscatePassphrase) {
                    throw new Error("Remote database is obfuscated but no obfuscate passphrase provided.");
                }
                this.config.hashAlg = tweaks.hashAlg ?? this.config.hashAlg;
                this.config.maxAgeInEden = tweaks.maxAgeInEden ?? this.config.maxAgeInEden;
                this.config.maxTotalLengthInEden = tweaks.maxTotalLengthInEden ?? this.config.maxTotalLengthInEden;
                this.config.maxChunksInEden = tweaks.maxChunksInEden ?? this.config.maxChunksInEden;
                this.config.useEden = tweaks.useEden ?? this.config.useEden;
                if (!this.config.enableCompression != !tweaks.enableCompression) {
                    throw new Error("Compression setting mismatched.");
                }
                this.config.useDynamicIterationCount = tweaks.useDynamicIterationCount ?? this.config.useDynamicIterationCount;
                this.config.enableChunkSplitterV2 = tweaks.enableChunkSplitterV2 ?? this.config.enableChunkSplitterV2;
                this.config.chunkSplitterVersion = tweaks.chunkSplitterVersion ?? this.config.chunkSplitterVersion;
                this.config.E2EEAlgorithm = tweaks.E2EEAlgorithm ?? this.config.E2EEAlgorithm;
                this.config.minimumChunkSize = tweaks.minimumChunkSize ?? this.config.minimumChunkSize;
                this.config.customChunkSize = tweaks.customChunkSize ?? this.config.customChunkSize;
                this.config.doNotUseFixedRevisionForChunks = tweaks.doNotUseFixedRevisionForChunks ?? this.config.doNotUseFixedRevisionForChunks;
                this.config.handleFilenameCaseSensitive = tweaks.handleFilenameCaseSensitive ?? this.config.handleFilenameCaseSensitive;
                const newConf = { ...this.config } as Record<string, any>;
                this.man.options = this.config;
                await this.man.liveSyncLocalDB.initializeDatabase()
                // await this.man.managers.initManagers();
                const diff = unique([...Object.keys(orgConf), ...Object.keys(tweaks)]).filter(k => orgConf[k] != newConf[k]);
                if (diff.length > 0) {
                    this.normalLog(`Remote tweaks changed --->`);
                    for (const diffKey of diff) {
                        this.normalLog(`${diffKey}\t: ${orgConf[diffKey]} \t : ${newConf[diffKey]}`);
                    }
                    this.normalLog(`<--- Remote tweaks changed`);
                }
            }
        }
        if (!w) {
            this.normalLog(`Remote database looks like empty. fetch from the first.`);
            this.setSetting("remote-created", "0");
            return;
        }
        const created = w.created;
        if (this.getSetting("remote-created") !== `${created}`) {
            this.man.since = "";
            this.normalLog(`Remote database looks like rebuilt. fetch from the first again.`);
            this.setSetting("remote-created", `${created}`);
        } else {
            this.normalLog(`Watch starting from ${this.man.since}`);
        }
        this.man.beginWatch(async (entry) => {
            const d = entry.type == "plain" ? entry.data : new Uint8Array(decodeBinary(entry.data));
            let path = entry.path.substring(baseDir.length);
            if (path.startsWith("/")) {
                path = path.substring(1);
            }
            if (entry.deleted || entry._deleted) {
                this.sendLog(`${path} delete detected`);
                await this.dispatchDeleted(path);
            } else {
                const docData = { ctime: entry.ctime, mtime: entry.mtime, size: entry.size, deleted: entry.deleted || entry._deleted, data: d };
                this.sendLog(`${path} change detected`);
                await this.dispatch(path, docData);
            }
        }, (entry) => {
            this.setSetting("since", this.man.since);
            if (entry.path.indexOf(":") !== -1) return false;
            return entry.path.startsWith(baseDir);
        });
    }
    async dispatch(path: string, data: FileData | false) {
        if (data === false) return;
        if (!await this.isRepeating(path, data)) {
            await this.dispatchToHub(this, this.toGlobalPath(path), data);
        }
        // else {
        //     this.receiveLog(`${path} dispatch repeating`);
        // }
    }
    async dispatchDeleted(path: string) {
        if (!await this.isRepeating(path, false)) {
            await this.dispatchToHub(this, this.toGlobalPath(path), false);
        }
    }
    async stop(): Promise<void> {
        this.man.endWatch();
        return await Promise.resolve();
    }
}
