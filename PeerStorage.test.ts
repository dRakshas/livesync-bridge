import { assertEquals } from "jsr:@std/assert";
import { join } from "@std/path";
import { PeerStorage } from "./PeerStorage.ts";
import type { DispatchFun } from "./Peer.ts";

const noopDispatch: DispatchFun = async () => {};

function makePeer(baseDir: string): PeerStorage {
    return new PeerStorage(
        { type: "storage", name: `test-${crypto.randomUUID()}`, baseDir },
        noopDispatch,
    );
}

async function fileExists(path: string): Promise<boolean> {
    try {
        await Deno.stat(path);
        return true;
    } catch {
        return false;
    }
}

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
// Expected: tmp removed on next start, main file absent (rename never ran).
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
// Expected: cleanup is a no-op, main file remains intact.
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

// Verify atomic put: file written correctly, no tmp remains after success.
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

// put + cleanupTmpFiles together: simulate a crash mid-put by leaving a tmp
// file, then verify cleanup removes it and a subsequent put works.
Deno.test("put after crash cleanup: successful put works after orphan removed", async () => {
    const dir = await Deno.makeTempDir();
    try {
        const peer = makePeer(dir);

        // Simulate orphan from prior crash
        await Deno.writeTextFile(join(dir, ".lsbridge-tmp-test.md"), "stale");

        await peer.cleanupTmpFiles();
        assertEquals(await fileExists(join(dir, ".lsbridge-tmp-test.md")), false);

        // Now a fresh put must succeed normally
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
