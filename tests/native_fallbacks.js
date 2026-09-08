"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { withProxy } = require("./common/proxy_harness.js");
const { NativePool, target } = require("./common/native_fixtures.js");

const poolFactoryNativePool = {
    poolFactory: timeout => new NativePool(timeout)
};

function nativeCapabilities(algos, perfs = {}) {
    return {
        algos: ["cn-heavy/xhv", ...algos],
        perfs,
        params: { extensions: ["mo-native"] }
    };
}

function lastGetjob(pool) {
    assert.ok(pool.getjobs.length > 0, "native miner did not request getjob");
    return pool.getjobs.at(-1).message;
}

async function waitForInitialGetjob(pool, miner) {
    await pool.waitForGetjobs(1);
    const request = pool.getjobs.at(-1);
    assert.ok(request.job, "fake pool getjob has no generated job");
    await miner.peer.waitForMessage(
        message => message.method === "job" && message.params && message.params.job_id === request.job.job_id,
        miner.timeoutMs, "initial native getjob delivery");
}

function assertClose(actual, expected, label) {
    assert.equal(typeof actual, "number", `${label} is not numeric`);
    const tolerance = Math.max(1, Math.abs(expected) * 1e-6);
    assert.ok(Math.abs(actual - expected) <= tolerance,
        `${label}: expected ${expected}, got ${actual}`);
}

class FakeNativePool extends NativePool {
    constructor(timeout) {
        super(timeout);
        this.pendingNativeSubmits = [];
    }

    onMessage(connection, message) {
        if (message.method === "mining.submit") {
            this.submits.push({ connection, message });
            this.pendingNativeSubmits.push({ connection, message });
            return;
        }

        super.onMessage(connection, message);
    }

    replyNativeSubmit(index, error = null) {
        const pending = this.pendingNativeSubmits[index];
        assert.ok(pending, `missing held native submit ${index}`);
        const response = {
            id: pending.message.id,
            jsonrpc: "2.0",
            error: null,
            result: true
        };
        if (error === false) response.result = false;
        else if (error) {
            response.error = error;
            response.result = null;
        }
        pending.connection.peer.send(response);
    }
}

test.describe("native fallback and forwarding boundaries", { concurrency: false }, () => {
    test("C29 hashless custom-diff shares retain pool difficulty and numeric proof submits", async () => {
        await withProxy(async ({ addMiner, pool, config }) => {
            const miner = await addMiner("c29-fallback+1000", nativeCapabilities(["c29"]));
            await waitForInitialGetjob(pool, miner);
            const login = miner.peer.messages.find(message => message.id === 1);
            const id = "c29-fallback-job";

            pool.push(pool.connections[0], "c29", id);
            const job = await miner.waitForJob(value => value.job_id === id, "C29 pre-pow job");
            assert.equal(job.difficulty, 10000);

            const pow = Array.from({ length: job.proofsize }, (_, index) => index + 1);
            miner.peer.send({ id: "c29-fallback-share", method: "submit", params: {
                id: login.result.id,
                job_id: id,
                algo: "c29",
                nonce: 7,
                pow
            } });

            const reply = await miner.peer.waitForMessage(message => message.id === "c29-fallback-share",
                config.timeoutMs, "C29 hashless share response");
            assert.equal(reply.error, null);
            await pool.waitForSubmits(1);

            const forwarded = pool.submits.find(item => item.message.params.job_id === id);
            assert.ok(forwarded, "C29 share did not reach the pool");
            assert.equal(forwarded.message.method, "submit");
            assert.equal(forwarded.message.params.id, forwarded.connection.rpcId);
            assert.equal(forwarded.message.params.nonce, 7);
            assert.deepEqual(forwarded.message.params.pow, pow);
            assert.equal(forwarded.message.params.result, undefined);
        }, poolFactoryNativePool);
    });

    test("KawPow aliases scale to hash/s, canonical names win, and C29 stays in cycles/s", async () => {
        const kawpowScale = 1099511627776 / 255;

        await withProxy(async ({ addMiner, pool }) => {
            await addMiner("kawpow-alias", nativeCapabilities(["kawpow"], {
                kawpow: 2
            }));
            await pool.waitForGetjobs(1);
            const request = lastGetjob(pool);
            assert.ok(request.params.algo.includes("kawpow1"));
            assertClose(request.params["algo-perf"].kawpow1, 2 * kawpowScale,
                "kawpow alias performance");
        }, poolFactoryNativePool);

        await withProxy(async ({ addMiner, pool }) => {
            await addMiner("kawpow4-alias", nativeCapabilities(["kawpow4"], {
                kawpow4: 3
            }));
            await pool.waitForGetjobs(1);
            const request = lastGetjob(pool);
            assert.ok(request.params.algo.includes("kawpow1"));
            assertClose(request.params["algo-perf"].kawpow1, 3 * kawpowScale,
                "kawpow4 alias performance");
        }, poolFactoryNativePool);

        await withProxy(async ({ addMiner, pool }) => {
            await addMiner("kawpow-canonical", nativeCapabilities(["kawpow", "kawpow1"], {
                kawpow1: 7,
                kawpow: 2
            }));
            await pool.waitForGetjobs(1);
            const request = lastGetjob(pool);
            assert.ok(request.params.algo.includes("kawpow1"));
            assert.equal(request.params["algo-perf"].kawpow1, 7,
                "canonical kawpow1 performance wins over alias order");
        }, poolFactoryNativePool);

        await withProxy(async ({ addMiner, pool }) => {
            await addMiner("c29-performance", nativeCapabilities(["c29"], {
                c29: 3
            }));
            await pool.waitForGetjobs(1);
            const request = lastGetjob(pool);
            assert.equal(request.params["algo-perf"].c29, 3);
        }, poolFactoryNativePool);

        await withProxy(async ({ addMiner, pool }) => {
            await addMiner("legacy-kawpow", {
                algos: ["rx/0", "kawpow", "kawpow1", "c29"]
            });
            await pool.waitForGetjobs(1);
            const request = lastGetjob(pool);
            assert.deepEqual(request.params.algo, ["rx/0"]);
            assert.equal(request.params["algo-perf"].kawpow, undefined);
            assert.equal(request.params["algo-perf"].kawpow1, undefined);
        }, poolFactoryNativePool);
    });

    test("native rejection and reverse-order responses preserve escaped request IDs", async () => {
        const options = { poolFactory: timeout => new FakeNativePool(timeout) };

        await withProxy(async ({ addMiner, pool, config }) => {
            const miner = await addMiner("native-reverse", {
                algos: ["cn-heavy/xhv", "kawpow"],
                params: { extensions: ["mo-native", "submit-result"] }
            });
            await waitForInitialGetjob(pool, miner);

            miner.peer.send({ id: "late-native-subscribe", method: "mining.subscribe",
                params: ["offline-native"] });
            const subscription = await miner.peer.waitForMessage(
                message => message.id === "late-native-subscribe",
                config.timeoutMs, "late native subscription");
            assert.equal(subscription.error, null);
            const nonce = subscription.result[1].padEnd(16, "0");
            const jobId = "native-reverse-job";
            await (async () => {
                pool.push(pool.connections[0], "kawpow", jobId);
                await miner.peer.waitForMessage(
                    message => message.method === "mining.notify" && message.params[0] === jobId,
                    config.timeoutMs, "KawPow reverse-order job");
            })();

            const firstId = 'reject-"quote\\slash';
            const secondId = 'accept-"quote\\slash';
            const submit = id => miner.peer.send({
                id,
                method: "mining.submit",
                params: ["native-reverse", jobId, `0x${nonce}`,
                    `0x${"12".repeat(32)}`, `0x${"56".repeat(32)}`],
                result: target(20000)
            });

            submit(firstId);
            submit(secondId);
            await pool.waitForSubmits(2);
            assert.equal(pool.pendingNativeSubmits.length, 2);

            const escapedError = 'pool rejected "share\\path';
            pool.replyNativeSubmit(1);
            pool.replyNativeSubmit(0, { code: -42, message: escapedError });

            const rejected = await miner.peer.waitForMessage(message => message.id === firstId,
                config.timeoutMs, "escaped rejected native request");
            const accepted = await miner.peer.waitForMessage(message => message.id === secondId,
                config.timeoutMs, "escaped accepted native request");
            assert.ok(rejected.error);
            assert.equal(rejected.error.message, escapedError);
            assert.equal(accepted.error, null);

            const falseId = 'false-"quote\\slash';
            submit(falseId);
            await pool.waitForSubmits(3);
            pool.replyNativeSubmit(2, false);
            const falseRejected = await miner.peer.waitForMessage(message => message.id === falseId,
                config.timeoutMs, "boolean-false native rejection");
            assert.ok(falseRejected.error);
            assert.equal(falseRejected.error.message, "pool rejected share");
        }, options);
    });
});
