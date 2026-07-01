/**
 * Unified tests for PeerStorage — covers both PR #2 (atomic write, guards) and
 * PR #3 (startup cleanup, orphan handling, age guard).
 *
 * Uses isolated temp directories; no /root/vault touched.
 * CouchDB is not required for these unit-level tests.
 */
import { assertEquals, assertFalse } from "jsr:@std/assert@^1";
import { join, dirname, parse } from "@std/path";
import { PeerStorage } from "./PeerStorage.ts";
import { FileData } from "./types.ts";
import { DispatchFun } from "./Peer.ts";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function makePeer(dir: string, onHub?: DispatchFun, extra?: Partial<import("./types.ts").PeerStorageConf>) {
    return new PeerStorage(
        { type: "storage", name: "test", baseDir: dir + "/", ...extra },
        onHub ?? (async () => {}),
    );
}

function textData(content: string, mtime = 1_000_000): FileData {
    return { ctime: mtime, mtime, size: content.length, data: new TextEncoder().encode(content) };
}

async function fileExists(path: string): Promise<boolean> {
    try {
        await Deno.stat(path);
        return true;
    } catch {
        return false;
    }
}

// ── PR #2: atomic write, guards ─────────────────────────────────────────────

Deno.test("put: writeFileStat is called after rename (final file exists, tmp is gone)", async () => {
    const dir = await Deno.makeTempDir();
    try {
        let finalExisted = false;
        let tmpExisted = false;

        class SpyStorage extends PeerStorage {
            async writeFileStat(pathSrc: string, statSrc?: Deno.FileInfo) {
                const lp = this.toLocalPath(pathSrc);
                const path = this.toStoragePath(lp);
                const tmpPath = join(dirname(path), `.lsbridge-tmp-${parse(path).base}`);
                try { await Deno.stat(path); finalExisted = true; } catch { /* not there yet */ }
                try { await Deno.stat(tmpPath); tmpExisted = true; } catch { /* already renamed away */ }
                return super.writeFileStat(pathSrc, statSrc);
            }
        }

        const peer = new SpyStorage({ type: "storage", name: "test", baseDir: dir + "/" }, async () => {});
        const ok = await peer.put("notes.md", textData("hello"));

        assertEquals(ok, true, "put should succeed");
        assertEquals(finalExisted, true, "final file must exist when writeFileStat is called (rename happened first)");
        assertEquals(tmpExisted, false, "tmp file must be gone when writeFileStat is called (rename consumed it)");

        const content = await Deno.readTextFile(join(dir, "notes.md"));
        assertEquals(content, "hello");
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("put: tmp file is removed when rename fails", async () => {
    const dir = await Deno.makeTempDir();
    try {
        // Block the destination by making it a directory — rename(file, dir) → EISDIR on Linux
        const destPath = join(dir, "blocked.md");
        await Deno.mkdir(destPath);

        const peer = makePeer(dir);
        const ok = await peer.put("blocked.md", textData("data"));

        assertEquals(ok, false, "put should return false on rename failure");

        const tmpPath = join(dir, ".lsbridge-tmp-blocked.md");
        let tmpExists = false;
        try { await Deno.stat(tmpPath); tmpExists = true; } catch { /* expected NotFound */ }
        assertEquals(tmpExists, false, "tmp file must be cleaned up after failure");
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("put: rejects path whose basename starts with .lsbridge-tmp-", async () => {
    const dir = await Deno.makeTempDir();
    try {
        const peer = makePeer(dir);
        const ok = await peer.put(".lsbridge-tmp-notes.md", textData("should not be written"));
        assertEquals(ok, false, "put must reject paths using the reserved .lsbridge-tmp- prefix");

        let destExists = false;
        let doubleTmpExists = false;
        try { await Deno.stat(join(dir, ".lsbridge-tmp-notes.md")); destExists = true; } catch { /* expected */ }
        try { await Deno.stat(join(dir, ".lsbridge-tmp-.lsbridge-tmp-notes.md")); doubleTmpExists = true; } catch { /* expected */ }
        assertEquals(destExists, false, "no destination file should be created");
        assertEquals(doubleTmpExists, false, "no nested tmp file should be created");
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("dispatch: .lsbridge-tmp- path is ignored, hub not called", async () => {
    const dir = await Deno.makeTempDir();
    try {
        let hubCalled = false;
        const peer = makePeer(dir, async () => { hubCalled = true; });

        const tmpFilePath = join(dir, ".lsbridge-tmp-notes.md");
        await Deno.writeTextFile(tmpFilePath, "orphan");

        await peer.dispatch(tmpFilePath);
        await delay(400); // beyond 250ms internal delay — ensure no scheduled task fires

        assertFalse(hubCalled, "hub must not be called for .lsbridge-tmp- path");
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("dispatchDeleted: .lsbridge-tmp- path is ignored, hub not called", async () => {
    const dir = await Deno.makeTempDir();
    try {
        let hubCalled = false;
        const peer = makePeer(dir, async () => { hubCalled = true; });

        const tmpFilePath = join(dir, ".lsbridge-tmp-notes.md");
        await peer.dispatchDeleted(tmpFilePath);
        await delay(400);

        assertFalse(hubCalled, "hub must not be called for .lsbridge-tmp- deletion");
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("offline scan: orphaned .lsbridge-tmp- file is not dispatched to hub", async () => {
    const dir = await Deno.makeTempDir();
    try {
        const tmpFile = join(dir, ".lsbridge-tmp-notes.md");
        const realFile = join(dir, "notes.md");
        await Deno.writeTextFile(tmpFile, "orphaned temp content");
        await Deno.writeTextFile(realFile, "real content");

        const hubPaths: string[] = [];
        const peer = makePeer(
            dir,
            async (_source, path) => { hubPaths.push(path); },
            { scanOfflineChanges: true },
        );

        const startPromise = peer.startDenoFsWatch();

        // Wait for: scan walk + 250ms dispatch debounce + headroom
        await delay(700);
        await peer.stop();

        try { await Promise.race([startPromise, delay(500)]); } catch { /* ignore watcher errors */ }

        await delay(200);

        assertFalse(
            hubPaths.some((p) => p.includes(".lsbridge-tmp-")),
            "hub must never receive a .lsbridge-tmp- path from the offline scan",
        );
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

// ── PR #3: startup cleanup, crash scenarios ─────────────────────────────────

Deno.test("cleanupTmpFiles: removes orphaned tmp file", async () => {
    const dir = await Deno.makeTempDir();
    try {
        const tmpFile = join(dir, ".lsbridge-tmp-note.md");
        await Deno.writeTextFile(tmpFile, "orphaned");

        const peer = makePeer(dir);
        const count = await peer.cleanupTmpFiles();

        assertEquals(count, 1);
        assertEquals(await fileExists(tmpFile), false);
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("cleanupTmpFiles: increments temp_cleaned_on_start metric", async () => {
    const dir = await Deno.makeTempDir();
    try {
        const peer = makePeer(dir);
        await Deno.writeTextFile(join(dir, ".lsbridge-tmp-a.md"), "a");
        await Deno.writeTextFile(join(dir, ".lsbridge-tmp-b.md"), "b");

        await peer.cleanupTmpFiles();

        assertEquals(peer.getSetting("temp_cleaned_on_start"), "2");
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("cleanupTmpFiles: leaves non-tmp files untouched", async () => {
    const dir = await Deno.makeTempDir();
    try {
        const mainFile = join(dir, "note.md");
        await Deno.writeTextFile(mainFile, "main content");

        const peer = makePeer(dir);
        const count = await peer.cleanupTmpFiles();

        assertEquals(count, 0);
        assertEquals(await Deno.readTextFile(mainFile), "main content");
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("cleanupTmpFiles: recursive — finds tmp in subdirectory", async () => {
    const dir = await Deno.makeTempDir();
    try {
        const sub = join(dir, "notes");
        await Deno.mkdir(sub);
        const tmpFile = join(sub, ".lsbridge-tmp-deep.md");
        await Deno.writeTextFile(tmpFile, "deep tmp");

        const peer = makePeer(dir);
        const count = await peer.cleanupTmpFiles();

        assertEquals(count, 1);
        assertEquals(await fileExists(tmpFile), false);
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

// Crash scenario A: process died after writing tmp but before rename.
Deno.test("crash simulation: crash before rename → tmp cleaned, main file absent", async () => {
    const dir = await Deno.makeTempDir();
    try {
        const tmpFile = join(dir, ".lsbridge-tmp-note.md");
        await Deno.writeTextFile(tmpFile, "in-progress content");
        // main file does NOT exist — rename never happened

        const peer = makePeer(dir);
        await peer.cleanupTmpFiles();

        assertEquals(await fileExists(tmpFile), false, "orphaned tmp must be deleted");
        assertEquals(await fileExists(join(dir, "note.md")), false, "main file must not exist");
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

// Crash scenario B: process died after rename succeeded.
Deno.test("crash simulation: crash after rename → main file intact, no cleanup needed", async () => {
    const dir = await Deno.makeTempDir();
    try {
        const mainFile = join(dir, "note.md");
        await Deno.writeTextFile(mainFile, "final content");
        // no tmp file — rename completed before crash

        const peer = makePeer(dir);
        const count = await peer.cleanupTmpFiles();

        assertEquals(count, 0, "nothing to clean");
        assertEquals(await Deno.readTextFile(mainFile), "final content", "main file must be intact");
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("put: writes file atomically and leaves no tmp behind", async () => {
    const dir = await Deno.makeTempDir();
    try {
        const peer = makePeer(dir);
        const contentBytes = new TextEncoder().encode("hello world");
        const mtime = Date.now() - 5000;

        const ok = await peer.put("test.md", {
            ctime: mtime,
            mtime,
            size: contentBytes.length,
            data: contentBytes,
        });

        assertEquals(ok, true);
        assertEquals(await Deno.readTextFile(join(dir, "test.md")), "hello world");
        assertEquals(
            await fileExists(join(dir, ".lsbridge-tmp-test.md")),
            false,
            "no tmp file should remain after successful put",
        );
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("put after crash cleanup: successful put works after orphan removed", async () => {
    const dir = await Deno.makeTempDir();
    try {
        const peer = makePeer(dir);

        // Simulate orphan from prior crash
        await Deno.writeTextFile(join(dir, ".lsbridge-tmp-test.md"), "stale");

        await peer.cleanupTmpFiles();
        assertEquals(await fileExists(join(dir, ".lsbridge-tmp-test.md")), false);

        const contentBytes = new TextEncoder().encode("fresh content");
        const ok = await peer.put("test.md", {
            ctime: Date.now(),
            mtime: Date.now(),
            size: contentBytes.length,
            data: contentBytes,
        });

        assertEquals(ok, true);
        assertEquals(await Deno.readTextFile(join(dir, "test.md")), "fresh content");
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});
