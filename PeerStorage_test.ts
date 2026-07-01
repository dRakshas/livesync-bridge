/**
 * Tests for PeerStorage atomic write (tmp+rename) and .lsbridge-tmp- guard.
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

// ── Test 1: writeFileStat is called AFTER Deno.rename ──────────────────────

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

// ── Test 2: tmp file is cleaned up on failure ───────────────────────────────

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

// ── Test 3: put() guard — reserved .lsbridge-tmp- prefix is rejected ────────

Deno.test("put: rejects path whose basename starts with .lsbridge-tmp-", async () => {
    const dir = await Deno.makeTempDir();
    try {
        const peer = makePeer(dir);
        const ok = await peer.put(".lsbridge-tmp-notes.md", textData("should not be written"));
        assertEquals(ok, false, "put must reject paths using the reserved .lsbridge-tmp- prefix");

        // Neither the destination nor a nested tmp should have been created
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

// ── Test 4: dispatch() guard (basename check) — tmp path returns early, hub not called ───────

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

// ── Test 5: dispatchDeleted() guard (basename check) — defense-in-depth ────

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

// ── Test 6: offline scan (Deno branch, scanOfflineChanges:true) ─────────────
// Orphaned .lsbridge-tmp-* file in dir is walked but dispatch() guard fires early;
// the real file IS dispatched.

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

        // Start the Deno-branch watcher; scan runs first, then enters watchFs loop.
        const startPromise = peer.startDenoFsWatch();

        // Wait for: scan walk + 250ms dispatch debounce + headroom
        await delay(700);
        await peer.stop();

        // startDenoFsWatch should exit once watcherDeno is closed
        try { await Promise.race([startPromise, delay(500)]); } catch { /* ignore watcher errors */ }

        // Wait a bit more for any in-flight scheduled tasks to settle
        await delay(200);

        assertFalse(
            hubPaths.some((p) => p.includes(".lsbridge-tmp-")),
            "hub must never receive a .lsbridge-tmp- path from the offline scan",
        );
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});
