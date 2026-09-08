"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { FakePool, withProxy } = require("./common/proxy_harness.js");

class EasyPool extends FakePool {
    nextJob() { return Object.assign(super.nextJob(), { target: "ffffffff" }); }
}

test("unmodified MO XMRig submits CPU shares through the proxy", {
    skip: !process.env.XMRIG_PROXY_LEGACY_MINER,
    timeout: 60000
}, async () => {
    await withProxy(async ({ pool, proxyPort }) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-legacy-miner-"));
        const configPath = path.join(dir, "config.json");
        const config = {
            autosave: false, watch: false, "donate-level": 0, "donate-over-proxy": 0,
            "rebench-algo": false, "algo-min-time": 0,
            "algo-perf": Object.fromEntries(["cn/r", "cn-lite/1", "cn-pico", "cn/ccx", "cn/gpu",
                "argon2/chukwav2", "kawpow1", "ghostrider", "flex", "cn-heavy/xhv",
                "rx/0", "rx/graft", "rx/arq", "panthera"].map(algo => [algo, 1])),
            cpu: { enabled: true, "huge-pages": false, "huge-pages-jit": false,
                "memory-pool": false, "*": [[1, -1]] },
            opencl: { enabled: false }, cuda: { enabled: false },
            randomx: { rdmsr: false, wrmsr: false, numa: false, init: 1, mode: "light" },
            pools: [{ url: `127.0.0.1:${proxyPort}`, user: "legacy-binary", pass: "x",
                algo: "cn-heavy/xhv", tls: false, keepalive: false }]
        };
        fs.writeFileSync(configPath, JSON.stringify(config));
        const miner = spawn(process.env.XMRIG_PROXY_LEGACY_MINER, ["--config", configPath, "--no-color"],
            { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
        let output = "";
        miner.stdout.on("data", chunk => { output += chunk; });
        miner.stderr.on("data", chunk => { output += chunk; });
        const exited = new Promise(resolve => miner.once("exit", resolve));
        try {
            await pool.waitForSubmits(1);
            const share = pool.submits[0].message;
            assert.equal(share.method, "submit");
            assert.match(share.params.nonce, /^[0-9a-f]{8}$/i);
            assert.match(share.params.result, /^[0-9a-f]{64}$/i);
            assert.match(output, /OPENCL\s+disabled/);
            assert.match(output, /CUDA\s+disabled/);
        }
        catch (error) {
            error.message += `\n${output}`;
            throw error;
        }
        finally {
            miner.kill("SIGTERM");
            const kill = setTimeout(() => miner.kill("SIGKILL"), 2000);
            await exited;
            clearTimeout(kill);
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }, { poolFactory: timeout => new EasyPool(timeout) });
});
