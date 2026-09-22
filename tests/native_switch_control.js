"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { FakeMiner, withProxy } = require("./common/proxy_harness.js");
const { NativePool, fixture, target } = require("./common/native_fixtures.js");

const GPU_ALGOS = ["cn/gpu", "kawpow1", "etchash", "autolykos2"];
const GPU_PERFS = {
    "cn/gpu": 100,
    kawpow1: 200,
    etchash: 300,
    autolykos2: 400
};
const C29_ALGOS = [...GPU_ALGOS, "c29"];
const C29_PERFS = Object.assign({}, GPU_PERFS, { c29: 500 });
const SUPPORTED_ALGOS = [...C29_ALGOS, "pearlhash"];
const NATIVE_ARRAY_ALGOS = new Set(["kawpow1", "etchash", "autolykos2"]);
const UPSTREAM_EXTENSIONS = ["algo", "keepalive", "mo-native", "submit-result"];

function wireAlgorithm(algo) {
    if (algo === "kawpow1") return "kawpow";
    if (algo === "c29") return "cuckaroo";
    return algo;
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
        if (message.method === "login" && message.params &&
            Array.isArray(message.params.algo) && message.params.algo.includes("pearlhash")) {
            this.logins.push({ at: Date.now(), connection, message });
            connection.peer.send({ id: message.id, jsonrpc: "2.0", error: null, result: true });
            const notify = fixture("pearlhash", `switch-login-pearl-${++this.jobSeq}`)[0];
            connection.peer.send({ ...notify, method: "mining.notify" });
            return;
        }
        if (message.method !== "getjob") {
            return super.onMessage(connection, message);
        }

        const algorithm = this.selectAlgorithm(message);
        this.getjobs.push({ at: Date.now(), connection, message, algorithm });
        const result = {
            id: connection.rpcId,
            extra_nonce: "abcd",
            extensions: UPSTREAM_EXTENSIONS
        };
        if (algorithm === "pearlhash") {
            result.job = fixture("pearlhash", `switch-pearl-${++this.jobSeq}`)[0].params;
        }
        else if (algorithm === "c29") {
            result.job = fixture("c29", `switch-c29-${++this.jobSeq}`, "grin", connection.rpcId).at(-1).params;
        }
        connection.peer.send({ id: message.id, jsonrpc: "2.0", error: null, result: {
            ...result
        } });
    }

    pushMatchingJob(connection, algorithm, id, profile) {
        if (profile === "xtmc-no-xn") {
            for (const message of fixture("c29", id, "xtmc")) {
                if (message.params && !Array.isArray(message.params)) delete message.params.xn;
                connection.peer.send(message);
            }
            return;
        }
        this.push(connection, algorithm === "c29" ? "c29" : wireAlgorithm(algorithm), id, profile);
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
        extensions: capabilities.extensions || ["mo-native", "submit-result"]
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
        algorithm === "c29" ? "c29" : wireAlgorithm(algorithm), `${algorithm} native login algorithm`);
    assert.equal(typeof login.result.id, "string", `${algorithm} native login downstream ID`);
    if (login.result.extra_nonce !== undefined) {
        assert.equal(typeof login.result.extra_nonce, "string", `${algorithm} native login extra nonce`);
        const suffix = algorithm === "c29" ? "[0-9a-f]{0,2}" : "[0-9a-f]{2}";
        assert.match(login.result.extra_nonce, new RegExp(`^abcd${suffix}$`, "i"), `${algorithm} extra nonce`);
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
    const marker = jobAlgorithm(message);
    assert.ok(marker === wireAlgorithm(algorithm) || (algorithm === "c29" && marker === "c29"),
        `${algorithm} native job marker`);
    return message;
}

function nativeJobParams(message) {
    return message.params || (message.result && message.result.job);
}

function c29HashAtDifficulty(difficulty) {
    return Buffer.from(target(difficulty), "hex").reverse().toString("hex");
}

function littleEndianHex(bigEndian) {
    return Buffer.from(bigEndian, "hex").reverse().toString("hex");
}

function c29Proof(size) {
    return Array.from({ length: size }, (_, index) => index + 1);
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
            perfs: C29_PERFS,
            extensions: ["mo-native"]
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

test("submit-result C29 miners aggregate with distinct Grin and Xtmc nonce partitions", async () => {
    await withProxy(async ({ miners, proxyPort, config, pool }) => {
        const capabilities = {
            algos: ["c29"],
            perfs: { c29: 100 },
            extensions: ["mo-native", "submit-result"]
        };
        const first = await openNativeMiner({ miners, proxyPort, config }, "c29-result-first+1000", capabilities);
        const second = await openNativeMiner({ miners, proxyPort, config }, "c29-result-second+1000", capabilities);
        await pool.waitForGetjobs(1);
        const c29Requests = pool.getjobs.filter(request => request.algorithm === "c29");
        assert.ok(c29Requests.length >= 1, "submit-result C29 work was not requested");
        const upstreamConnection = c29Requests.at(-1).connection;
        assert.equal(pool.connections.length, 1, "submit-result C29 miners did not share one upstream");

        const logins = await Promise.all([
            waitForNativeLogin(first, "c29", config.timeoutMs),
            waitForNativeLogin(second, "c29", config.timeoutMs)
        ]);
        const initialParams = logins.map(login => login.result.job);
        assert.notEqual(initialParams[0].nonce, initialParams[1].nonce, "C29 Grin nonce slots were reused");
        for (const params of initialParams) {
            assert.ok((params.nonce >>> 24) >= 0 && (params.nonce >>> 24) < 256,
                "C29 Grin nonce does not carry a fixed slot");
            assert.equal(params.nicehash_mask, 0xff000000, "C29 Grin mask was not advertised");
            assert.equal(params.difficulty, 1000, "C29 result miner did not receive its custom difficulty");
        }

        const xtmcId = "c29-result-xtmc";
        pool.pushMatchingJob(upstreamConnection, "c29", xtmcId, "xtmc");
        const xtmcJobs = await Promise.all([
            waitForNativeJob(first, "c29", xtmcId, config.timeoutMs),
            waitForNativeJob(second, "c29", xtmcId, config.timeoutMs)
        ]);
        const xtmcParams = xtmcJobs.map(nativeJobParams);
        assert.notEqual(xtmcParams[0].xn, xtmcParams[1].xn, "C29 Xtmc nonce prefixes were reused");
        for (const params of xtmcParams) {
            assert.match(params.xn, /^abcd[0-9a-f]{2}$/i, "C29 Xtmc slot was not appended to xn");
        }

        const noXnId = "c29-result-xtmc-no-xn";
        pool.pushMatchingJob(upstreamConnection, "c29", noXnId, "xtmc-no-xn");
        const noXnJobs = await Promise.all([
            waitForNativeJob(first, "c29", noXnId, config.timeoutMs),
            waitForNativeJob(second, "c29", noXnId, config.timeoutMs)
        ]);
        for (const params of noXnJobs.map(nativeJobParams)) {
            assert.match(params.xn, /^abcd[0-9a-f]{2}$/i, "C29 Xtmc missing xn was not partitioned");
        }

        const grinId = "c29-result-grin";
        pool.pushMatchingJob(upstreamConnection, "c29", grinId, "grin");
        const grinJobs = await Promise.all([
            waitForNativeJob(first, "c29", grinId, config.timeoutMs),
            waitForNativeJob(second, "c29", grinId, config.timeoutMs)
        ]);
        const grinParams = grinJobs.map(nativeJobParams);
        const proof = c29Proof(grinParams[0].proofsize);
        const localOnly = {
            id: logins[0].result.id,
            job_id: grinId,
            algo: "c29",
            nonce: grinParams[0].nonce,
            pow: proof,
            result: c29HashAtDifficulty(5000)
        };
        first.miner.peer.send({ id: "c29-local-only", method: "submit", params: localOnly });
        const localReply = await first.miner.peer.waitForMessage(message => message.id === "c29-local-only",
            config.timeoutMs, "C29 local-only result");
        assert.equal(localReply.error, null, "C29 local-valid result was not accepted locally");
        assert.equal(pool.submits.length, 0, "C29 local-only result was forwarded upstream");

        const forwarded = { ...localOnly, job_id: grinId, result: c29HashAtDifficulty(20000) };
        first.miner.peer.send({ id: "c29-forwarded", method: "submit", params: forwarded });
        const forwardedReply = await first.miner.peer.waitForMessage(message => message.id === "c29-forwarded",
            config.timeoutMs, "C29 upstream-valid result");
        assert.equal(forwardedReply.error, null, "C29 upstream-valid result was rejected");
        await pool.waitForSubmits(1);
        assert.equal(pool.submits[0].message.params.result, forwarded.result);

        const wrongPrefix = { ...forwarded, nonce: grinParams[1].nonce };
        first.miner.peer.send({ id: "c29-wrong-prefix", method: "submit", params: wrongPrefix });
        const wrongReply = await first.miner.peer.waitForMessage(message => message.id === "c29-wrong-prefix",
            config.timeoutMs, "C29 wrong prefix rejection");
        assert.ok(wrongReply.error, "C29 wrong fixed-byte prefix was accepted");
        assert.equal(pool.submits.length, 1, "C29 wrong prefix reached the upstream");
    }, { poolFactory: timeout => new SwitchingNativePool(timeout) });
});

test("Pearl seed-split miners share an upstream with distinct nonce slots across Pearl switches", async () => {
    await withProxy(async ({ miners, proxyPort, config, pool }) => {
        const pearlCapabilities = {
            algos: ["pearlhash"],
            perfs: { pearlhash: 100 },
            extensions: ["mo-native", "submit-result", "pearl-seed-split"]
        };
        const first = await openNativeMiner({ miners, proxyPort, config }, "pearl-seed-first", pearlCapabilities);
        const second = await openNativeMiner({ miners, proxyPort, config }, "pearl-seed-second", pearlCapabilities);
        await pool.waitForLogins(2);

        const pearlLogins = pool.logins.filter(login => login.message.params.algo.includes("pearlhash"));
        assert.ok(pearlLogins.length >= 1, "supporting Pearl miners did not request Pearl work");
        const upstreamConnection = pearlLogins.at(-1).connection;
        assert.equal(pool.logins.filter(login => login.connection === upstreamConnection).length, 1,
            "supporting Pearl miners did not share one upstream login");

        const initialId = "pearl-seed-initial";
        pool.pushMatchingJob(upstreamConnection, "pearlhash", initialId);
        const logins = await Promise.all([
            waitForNativeLogin(first, "pearlhash", config.timeoutMs),
            waitForNativeLogin(second, "pearlhash", config.timeoutMs)
        ]);
        for (const login of logins) {
            assert.ok(login.result.extensions.includes("pearl-seed-split"),
                "Pearl seed-split extension was not acknowledged");
        }
        const initialJobs = await Promise.all([
            waitForNativeJob(first, "pearlhash", initialId, config.timeoutMs),
            waitForNativeJob(second, "pearlhash", initialId, config.timeoutMs)
        ]);
        const initialParams = initialJobs.map(nativeJobParams);
        assert.notEqual(initialParams[0].nonce_slot, initialParams[1].nonce_slot, "supporting Pearl miners reused a nonce slot");
        for (const params of initialParams) {
            assert.equal(Number.isInteger(params.nonce_slot), true, "Pearl nonce slot is not an integer");
            assert.ok(params.nonce_slot >= 0 && params.nonce_slot < 256, "Pearl nonce slot is outside the fixed-byte range");
            assert.equal(params.nonce_stride, 256, "Pearl nonce stride is not 256");
        }

        const switchedId = "pearl-seed-switched";
        pool.pushMatchingJob(upstreamConnection, "pearlhash", switchedId);
        const switchedJobs = await Promise.all([
            waitForNativeJob(first, "pearlhash", switchedId, config.timeoutMs),
            waitForNativeJob(second, "pearlhash", switchedId, config.timeoutMs)
        ]);
        const switchedParams = switchedJobs.map(nativeJobParams);
        assert.deepEqual(switchedParams.map(params => params.nonce_slot), initialParams.map(params => params.nonce_slot),
            "Pearl fixed slots changed across a switched job");
        assert.deepEqual(switchedParams.map(params => params.nonce_stride), [256, 256]);
    }, { poolFactory: timeout => new SwitchingNativePool(timeout) });
});

test("native Pearl without seed-split stays isolated from supporting Pearl aggregation", async () => {
    await withProxy(async ({ miners, proxyPort, config, pool }) => {
        const supported = await openNativeMiner({ miners, proxyPort, config }, "pearl-seed-supported", {
            algos: ["pearlhash"],
            perfs: { pearlhash: 100 },
            extensions: ["mo-native", "submit-result", "pearl-seed-split"]
        });
        const unsupported = await openNativeMiner({ miners, proxyPort, config }, "pearl-seed-legacy", {
            algos: ["pearlhash"],
            perfs: { pearlhash: 100 }
        });
        await pool.waitForLogins(3);

        const pearlLogins = pool.logins.filter(login => login.message.params.algo.includes("pearlhash"));
        assert.ok(pearlLogins.length >= 2, "Pearl capability requests were not observed");
        const supportedConnection = pearlLogins[0].connection;
        const unsupportedConnection = pearlLogins.at(-1).connection;
        assert.notEqual(supportedConnection, unsupportedConnection,
            "native Pearl without seed-split shared the supporting miner upstream");
        assert.equal(pool.connections.length, 3, "isolated Pearl did not receive a dedicated upstream");
        assert.equal(supported.miner.peer.closed, false);
        assert.equal(unsupported.miner.peer.closed, false);
    }, { poolFactory: timeout => new SwitchingNativePool(timeout) });
});

test("negotiated Pearl validates endian boundaries, local-only claims, and overflow", async () => {
    await withProxy(async ({ miners, proxyPort, config, pool }) => {
        const miner = await openNativeMiner({ miners, proxyPort, config }, "pearl-claims+1000", {
            algos: ["pearlhash"],
            perfs: { pearlhash: 100 },
            extensions: ["mo-native", "submit-result", "pearl-seed-split"]
        });
        await pool.waitForLogins(2);
        const login = await waitForNativeLogin(miner, "pearlhash", config.timeoutMs);
        const initialJob = login.result.job;
        assert.equal(initialJob.target, target(1000), "negotiated Pearl target was not reduced canonically");
        assert.equal(initialJob.nonce, undefined, "negotiated Pearl overwrote the hashing nonce");
        assert.equal(initialJob.nonce_stride, 256);
        assert.equal(Number.isInteger(initialJob.nonce_slot), true);

        const upstreamTarget = target(10000);
        const submit = async (id, jackpot, factor) => {
            const params = { job_id: initialJob.job_id, plain_proof: "cHJvb2Y=", jackpot, adjustment_factor: factor };
            miner.miner.peer.send({ id, method: "mining.submit", params });
            return miner.miner.peer.waitForMessage(message => message.id === id, config.timeoutMs, `${id} Pearl claim`);
        };

        const localOnly = await submit("pearl-local-boundary", littleEndianHex(target(1000)), 1);
        assert.equal(localOnly.error, null, "local target boundary was rejected");
        assert.equal(pool.submits.length, 0, "local-only Pearl claim was forwarded");

        const forwarded = await submit("pearl-upstream-boundary", littleEndianHex(upstreamTarget), 1);
        assert.equal(forwarded.error, null, "upstream target boundary was rejected");
        await pool.waitForSubmits(1);
        assert.equal(pool.submits[0].message.params.jackpot, littleEndianHex(upstreamTarget));

        const belowLocal = await submit("pearl-below-local", littleEndianHex(target(500)), 1);
        assert.ok(belowLocal.error, "below-local Pearl claim was accepted");
        assert.equal(pool.submits.length, 1, "below-local Pearl claim was forwarded");

        const overflowLocalOnly = await submit("pearl-overflow-local", "0".repeat(64), 0xffffffff);
        assert.equal(overflowLocalOnly.error, null, "local overflow threshold was not saturated");
        assert.equal(pool.submits.length, 1, "overflow local-only Pearl claim was forwarded");

        const malformed = await submit("pearl-uppercase", littleEndianHex(upstreamTarget).toUpperCase(), 1);
        assert.ok(malformed.error, "uppercase jackpot was accepted");
        assert.equal(pool.submits.length, 1, "malformed Pearl claim was forwarded");
    }, { poolFactory: timeout => new SwitchingNativePool(timeout) });
});
