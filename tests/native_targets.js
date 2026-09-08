"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");


test("native target helper executable passes standalone checks", (t) => {
    const nativeTargetBinary = process.env.XMRIG_PROXY_NATIVE_TARGET_BINARY;
    const proxyBinary = process.env.XMRIG_PROXY_TEST_BINARY;

    if (!nativeTargetBinary || !proxyBinary) {
        t.skip("native-target-tests sibling binary is unavailable; use a normal build or provide --binary");
        return;
    }

    assert.ok(fs.existsSync(nativeTargetBinary), `native target test binary not found: ${nativeTargetBinary}`);
    assert.equal(
        path.dirname(path.resolve(nativeTargetBinary)),
        path.dirname(path.resolve(proxyBinary)),
        "native target test binary must be beside the configured proxy binary"
    );

    const result = spawnSync(nativeTargetBinary, [], {
        cwd: path.dirname(nativeTargetBinary),
        encoding: "utf8",
        windowsHide: true
    });

    assert.ifError(result.error);
    assert.equal(
        result.status,
        0,
        `native target tests exited with status ${result.status} (signal ${result.signal})\n` +
        `${result.stdout || ""}${result.stderr || ""}`
    );
});
