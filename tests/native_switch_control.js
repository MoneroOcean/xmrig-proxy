"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { FakeMiner, withProxy } = require("./common/proxy_harness.js");
const { NativePool, fixture } = require("./common/native_fixtures.js");

const GPU_ALGOS = ["cn/gpu", "kawpow1", "etchash", "autolykos2"];
const GPU_PERFS = {
    "cn/gpu": 100,
    kawpow1: 200,
    etchash: 300,
    autolykos2: 400
};
const C29_ALGOS = [...GPU_ALGOS, "c29"];
const C29_PERFS = Object.assign({}, GPU_PERFS, { c29: 500 });
const SUPPORTED_ALGOS = [...C29_ALGOS];
const NATIVE_ARRAY_ALGOS = new Set(["kawpow1", "etchash", "autolykos2"]);
const UPSTREAM_EXTENSIONS = ["algo", "keepalive", "mo-native", "submit-result"];

function wireAlgorithm(algo) {
    return algo === "kawpow1" ? "kawpow" : algo;
}

function jobMessage(message, id) {
    return (message.method === "job" && message.params && message.params.job_id === id) ||
        (message.method === "mining.notify" && Array.isArray(message.params) && message.params[0] === id) ||
        (message.result && message.result.job && message.result.job.job_id === id);
}

function jobAlgorithm(message) {
    return message.algo || (message.params && message.params.algo) ||
        (message.result && message.result.job && message.result.job.algo);
}

function assertCapabilityRequest(request, algos, perfs, label) {
    assert.ok(request && request.message && request.message.params, `${label} missing request`);
    assert.deepEqual([...request.message.params.algo].sort(), [...algos].sort(), `${label} algorithm set`);
    assert.deepEqual(request.message.params["algo-perf"], perfs, `${label} algo-perf`);
}

class SwitchingNativePool extends NativePool {
    selectAlgorithm(message) {
        const requested = Array.isArray(message.params && message.params.algo)
            ? message.params.algo : [];
        return SUPPORTED_ALGOS.find(algo => requested.includes(algo) ||
            (algo === "kawpow1" && requested.includes("kawpow"))) || GPU_ALGOS[0];
    }

    onMessage(connection, message) {
        if (message.method !== "getjob") {
            return super.onMessage(connection, message);
        }

        const algorithm = this.selectAlgorithm(message);
        this.getjobs.push({ at: Date.now(), connection, message, algorithm });
        connection.peer.send({ id: message.id, jsonrpc: "2.0", error: null, result: {
            id: connection.rpcId,
            extra_nonce: "abcd",
            extensions: UPSTREAM_EXTENSIONS
        } });
    }

    pushMatchingJob(connection, algorithm, id) {
        this.push(connection, wireAlgorithm(algorithm), id);
    }
}

async function openNativeMiner({ miners, proxyPort, config }, name, capabilities) {
    const miner = new FakeMiner(name, proxyPort, config.timeoutMs);
    miners.push(miner);
    await miner.connect();
    const id = `${name}-login`;
    miner.peer.send({ id, jsonrpc: "2.0", method: "login", params: {
        login: name,
        pass: "x",
        agent: "offline-native-switch-control",
        algo: [...capabilities.algos],
        "algo-perf": Object.assign({}, capabilities.perfs),
        extensions: ["mo-native", "submit-result"]
    } });
    return { id, miner };
}

async function waitForNativeExtranonce(handle, algorithm, timeoutMs, label) {
    const extranonce = await handle.miner.peer.waitForMessage(
        message => message.method === "mining.set_extranonce" && message.algo === wireAlgorithm(algorithm),
        timeoutMs, label || `${algorithm} native extranonce assignment`);
    assert.deepEqual(extranonce.params, [extranonce.params[0], 5],
        `${algorithm} native extranonce width`);
    assert.match(extranonce.params[0], /^abcd[0-9a-f]{2}$/i,
        `${algorithm} native extranonce prefix`);
    return extranonce;
}

async function waitForNativeLogin(handle, algorithm, timeoutMs) {
    const login = await handle.miner.peer.waitForMessage(
        message => message.id === handle.id, timeoutMs, `${algorithm} native login`);
    assert.equal(login.error, null, `${algorithm} native login error`);
    assert.ok(login.result, `${algorithm} native login has no result`);
    assert.equal(login.result.status, "OK", `${algorithm} native login status`);
    assert.equal(login.result.algo || (login.result.job && login.result.job.algo),
        wireAlgorithm(algorithm), `${algorithm} native login algorithm`);
    assert.equal(typeof login.result.id, "string", `${algorithm} native login downstream ID`);
    if (login.result.extra_nonce !== undefined) {
        assert.equal(typeof login.result.extra_nonce, "string", `${algorithm} native login extra nonce`);
        assert.match(login.result.extra_nonce, /^abcd[0-9a-f]{2}$/i, `${algorithm} extra nonce`);
    }

    if (NATIVE_ARRAY_ALGOS.has(algorithm)) {
        assert.equal(typeof login.result.extra_nonce, "string", `${algorithm} native login extra nonce`);
        const extranonce = await waitForNativeExtranonce(handle, algorithm, timeoutMs);
        assert.equal(extranonce.params[0], login.result.extra_nonce,
            `${algorithm} native extranonce matches login assignment`);
    }
    else {
        assert.ok(login.result.job, `${algorithm} object-native login has no initial job`);
        assert.equal(login.result.job.algo, algorithm, `${algorithm} object-native job algorithm`);
    }

    return login;
}

async function waitForNativeJob(handle, algorithm, id, timeoutMs) {
    const message = await handle.miner.peer.waitForMessage(
        candidate => jobMessage(candidate, id), timeoutMs, `${algorithm} native job ${id}`);
    assert.equal(jobAlgorithm(message), wireAlgorithm(algorithm), `${algorithm} native job marker`);
    return message;
}

async function closeMiner(handle) {
    if (handle.miner.peer.closed) {
        return;
    }

    const closed = new Promise(resolve => handle.miner.peer.once("closed", resolve));
    handle.miner.close();
    await closed;
}

async function waitForNextGetjob(pool, count, connection, label) {
    await pool.waitForGetjobs(count);
    const request = pool.getjobs.at(-1);
    if (connection) {
        assert.equal(request.connection, connection, `${label} reused the upstream socket`);
    }
    assert.equal(pool.connections.length, 1, `${label} opened another upstream socket`);
    assert.equal(pool.logins.length, 1, `${label} opened another upstream login`);
    return request;
}

test("native GPU capability controls narrow and widen one upstream through a full cycle", async () => {
    await withProxy(async ({ miners, proxyPort, config, pool }) => {
        const mainCapabilities = { algos: GPU_ALGOS, perfs: GPU_PERFS };
        const main = await openNativeMiner({ miners, proxyPort, config }, "native-switch-main", mainCapabilities);
        const mainSocket = main.miner.socket;

        const initial = await waitForNextGetjob(pool, 1, null, "initial capability request");
        const upstreamConnection = initial.connection;
        assertCapabilityRequest(initial, GPU_ALGOS, GPU_PERFS, "main capability request");
        assert.equal(initial.algorithm, "cn/gpu", "main fixture did not select the first GPU algorithm");

        const initialJobId = "native-switch-initial";
        pool.pushMatchingJob(upstreamConnection, initial.algorithm, initialJobId);
        await Promise.all([
            waitForNativeLogin(main, initial.algorithm, config.timeoutMs),
            waitForNativeJob(main, initial.algorithm, initialJobId, config.timeoutMs)
        ]);

        let getjobCount = 1;
        let activeControl = null;
        const cycle = [...GPU_ALGOS, GPU_ALGOS[0]];

        for (const [index, algorithm] of cycle.entries()) {
            if (activeControl) {
                await closeMiner(activeControl);
                const widened = await waitForNextGetjob(pool, ++getjobCount, upstreamConnection,
                    `${algorithm} pre-attach widening`);
                assertCapabilityRequest(widened, GPU_ALGOS, GPU_PERFS,
                    `${algorithm} widened capability request`);
                assert.equal(main.miner.socket, mainSocket, `${algorithm} widening replaced main socket`);
                assert.equal(main.miner.peer.closed, false, `${algorithm} widening closed main miner`);
            }

            const control = await openNativeMiner({ miners, proxyPort, config },
                `native-switch-control-${index}-${algorithm}`, {
                    algos: [algorithm],
                    perfs: { [algorithm]: GPU_PERFS[algorithm] }
                });

            const narrowed = await waitForNextGetjob(pool, ++getjobCount, upstreamConnection,
                `${algorithm} narrowing`);
            assertCapabilityRequest(narrowed, [algorithm], { [algorithm]: GPU_PERFS[algorithm] * 2 },
                `${algorithm} narrowed capability request`);

            const jobId = `native-switch-${index}-${algorithm}`;
            pool.pushMatchingJob(upstreamConnection, algorithm, jobId);
            await Promise.all([
                waitForNativeLogin(control, algorithm, config.timeoutMs),
                waitForNativeJob(control, algorithm, jobId, config.timeoutMs),
                waitForNativeJob(main, algorithm, jobId, config.timeoutMs),
                NATIVE_ARRAY_ALGOS.has(algorithm)
                    ? waitForNativeExtranonce(main, algorithm, config.timeoutMs,
                        `${algorithm} main native extranonce assignment`)
                    : Promise.resolve()
            ]);

            assert.equal(main.miner.socket, mainSocket, `${algorithm} job replaced main socket`);
            assert.equal(main.miner.peer.closed, false, `${algorithm} job closed main miner`);
            activeControl = control;
        }

        await closeMiner(activeControl);
        const finalWidened = await waitForNextGetjob(pool, ++getjobCount, upstreamConnection,
            "final capability widening");
        assertCapabilityRequest(finalWidened, GPU_ALGOS, GPU_PERFS, "final widened capability request");
        assert.equal(main.miner.socket, mainSocket, "final widening replaced main socket");
        assert.equal(main.miner.peer.closed, false, "final widening closed main miner");
    }, { poolFactory: timeout => new SwitchingNativePool(timeout) });
});

test("native C29 capability keeps a control miner on a separate upstream", async () => {
    await withProxy(async ({ miners, proxyPort, config, pool }) => {
        const main = await openNativeMiner({ miners, proxyPort, config }, "native-c29-main", {
            algos: C29_ALGOS,
            perfs: C29_PERFS
        });
        const initial = await waitForNextGetjob(pool, 1, null, "C29 initial capability request");
        const mainConnection = initial.connection;
        assertCapabilityRequest(initial, C29_ALGOS, C29_PERFS, "C29 main capability request");

        const initialJobId = "native-c29-isolation-initial";
        pool.pushMatchingJob(mainConnection, initial.algorithm, initialJobId);
        await Promise.all([
            waitForNativeLogin(main, initial.algorithm, config.timeoutMs),
            waitForNativeJob(main, initial.algorithm, initialJobId, config.timeoutMs)
        ]);

        await openNativeMiner({ miners, proxyPort, config }, "native-c29-control", {
            algos: ["cn/gpu"],
            perfs: { "cn/gpu": GPU_PERFS["cn/gpu"] }
        });
        await pool.waitForLogins(2);
        await pool.waitForGetjobs(2);
        const controlRequest = pool.getjobs.at(-1);
        assert.notEqual(controlRequest.connection, mainConnection,
            "C29-advertising main unexpectedly shared its upstream connection");
        assert.equal(pool.connections.length, 2, "C29 control did not create its separate upstream");
        assert.equal(pool.logins.length, 2, "C29 control did not create its separate upstream login");
    }, { poolFactory: timeout => new SwitchingNativePool(timeout) });
});
