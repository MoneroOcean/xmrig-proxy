"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { FakeMiner, withProxy } = require("./common/proxy_harness.js");
const { FixedNativePool, NativePool, fixture, target } = require("./common/native_fixtures.js");

const MAX = (1n << 256n) - 1n;
const nativeOptions = { poolFactory: timeout => new NativePool(timeout) };

function decimalTarget(difficulty) {
    return (MAX / BigInt(difficulty)).toString();
}

function nativeCapabilities(algos) {
    return {
        algos: ["cn-heavy/xhv", ...algos],
        params: { extensions: ["mo-native", "submit-result"] }
    };
}

async function waitForInitialGetjob(pool, miner) {
    await pool.waitForGetjobs(1);
    const request = pool.getjobs.at(-1);
    assert.ok(request.job, "fake pool getjob has no generated job");
    await miner.peer.waitForMessage(
        message => message.method === "job" && message.params && message.params.job_id === request.job.job_id,
        miner.timeoutMs, "initial native getjob delivery");
}

async function subscribe(miner, id) {
    miner.peer.send({ id, method: "mining.subscribe", params: ["offline-native"] });
    const response = await miner.peer.waitForMessage(
        message => message.id === id, miner.timeoutMs, "native subscription");
    assert.equal(response.error, null);
    assert.ok(Array.isArray(response.result));
    assert.equal(typeof response.result[1], "string");
    return response.result[1];
}

async function notify(miner, id) {
    return miner.peer.waitForMessage(
        message => message.method === "mining.notify" && message.params && message.params[0] === id,
        miner.timeoutMs, `native notify ${id}`);
}

function nativeParams(algo, wallet, jobId, prefix) {
    const fullNonce = prefix.padEnd(16, "0");
    if (algo === "autolykos2") {
        return [wallet, jobId, fullNonce.slice(prefix.length), "01020304", fullNonce];
    }

    return [wallet, jobId, `0x${fullNonce}`, `0x${"12".repeat(32)}`, `0x${"56".repeat(32)}`];
}

async function submitNative(miner, id, params, hash) {
    miner.peer.send({ id, method: "mining.submit", params, result: hash });
    return miner.peer.waitForMessage(
        message => message.id === id, miner.timeoutMs, `native submit ${id}`);
}

function assertForwarded(pool, jobId, params, hash, autolykos) {
    const forwarded = pool.submits.find(item => item.message.params[1] === jobId &&
        item.message.result === hash);
    assert.ok(forwarded, `${jobId} was not forwarded to the pool`);
    assert.equal(forwarded.message.method, "mining.submit");
    assert.equal(forwarded.message.params.length, 5);
    if (autolykos) {
        assert.equal(forwarded.message.params[2], params[4], "Ergo pool nonce includes prefix and suffix");
        assert.equal(forwarded.message.params[3], params[3]);
        assert.equal(forwarded.message.params[4], params[4]);
    }
    else {
        assert.deepEqual(forwarded.message.params.slice(1), params.slice(1));
    }
    assert.equal(forwarded.message.result, hash);
    return forwarded;
}

test.describe("native lifecycle boundaries", { concurrency: false }, () => {
    test("lowered ETH, Etchash, and Ergo targets rewrite correctly and preserve submit layouts", async () => {
        await withProxy(async ({ addMiner, pool, config }) => {
            const miner = await addMiner("native-lifecycle+1000", nativeCapabilities([
                "ethash", "etchash", "autolykos2"
            ]));
            await waitForInitialGetjob(pool, miner);
            const prefix = await subscribe(miner, "lifecycle-subscribe");

            for (const algo of ["ethash", "etchash", "autolykos2"]) {
                const jobId = `lifecycle-${algo}`;
                pool.push(pool.connections[0], algo, jobId);
                const control = await miner.peer.waitForMessage(
                    message => message.method === "mining.set_difficulty" && message.algo === algo,
                    config.timeoutMs, `${algo} difficulty control`);
                const received = await notify(miner, jobId);
                const expected = fixture(algo, jobId).at(-1).params;

                if (algo === "ethash" || algo === "etchash") {
                    assert.ok(Math.abs(control.params[0] - 1000 / 0x100000000) < 1e-15,
                        `${algo} custom target`);
                    assert.deepEqual(received.params, expected, `${algo} notify shape`);
                }
                else {
                    assert.equal(control.params[0], 1, "Ergo control remains the pool control");
                    assert.deepEqual(received.params.slice(0, 6), expected.slice(0, 6), "Ergo notify prefix");
                    assert.equal(received.params[6], decimalTarget(1000), "Ergo custom target");
                    assert.deepEqual(received.params.slice(7), expected.slice(7), "Ergo notify suffix");
                }

                const params = nativeParams(algo, "native-lifecycle", jobId, prefix);
                const before = pool.submits.length;
                const local = await submitNative(miner, `local-${algo}`, params, target(2000));
                assert.equal(local.error, null, `${algo} hash-2000 local share`);
                assert.equal(pool.submits.length, before, `${algo} intermediate share stayed local`);

                const forwardedId = `forward-${algo}`;
                const forwardedResponse = await submitNative(miner, forwardedId, params, target(20000));
                assert.equal(forwardedResponse.error, null, `${algo} pool share response`);
                await pool.waitForSubmits(before + 1);
                assertForwarded(pool, jobId, params, target(20000), algo === "autolykos2");

                if (algo === "ethash") {
                    const atMinerBoundary = await submitNative(miner, "miner-boundary", params, target(1000));
                    assert.equal(atMinerBoundary.error, null, "hash at custom-difficulty boundary is local");
                    assert.equal(pool.submits.length, before + 1);

                    const aboveMinerBoundary = (BigInt(`0x${target(1000)}`) + 1n)
                        .toString(16).padStart(64, "0");
                    const rejected = await submitNative(miner, "above-miner-boundary", params, aboveMinerBoundary);
                    assert.ok(rejected.error, "hash above custom-difficulty target is rejected");
                    assert.equal(pool.submits.length, before + 1);

                    const atPoolBoundary = await submitNative(miner, "pool-boundary", params, target(10000));
                    assert.equal(atPoolBoundary.error, null, "hash at pool target boundary is forwarded");
                    await pool.waitForSubmits(before + 2);
                    assertForwarded(pool, jobId, params, target(10000), false);
                }
            }
        }, nativeOptions);
    });

    test("a previous native KawPow job remains submit-capable after switching to RX", async () => {
        await withProxy(async ({ addMiner, pool, config }) => {
            const miner = await addMiner("native-previous-kaw", nativeCapabilities(["kawpow", "rx/0"]));
            await waitForInitialGetjob(pool, miner);
            const prefix = await subscribe(miner, "previous-subscribe");
            const oldJobId = "previous-native-kawpow";
            pool.push(pool.connections[0], "kawpow", oldJobId);
            const oldJob = await notify(miner, oldJobId);
            assert.equal(oldJob.params[3], target(10000));

            const nextJobId = "current-rx-job";
            pool.push(pool.connections[0], "rx/0", nextJobId);
            await miner.peer.waitForMessage(
                message => message.method === "job" && message.params && message.params.job_id === nextJobId,
                config.timeoutMs, "RX switch job");

            const params = nativeParams("kawpow", "native-previous-kaw", oldJobId, prefix);
            const response = await submitNative(miner, "previous-kaw-submit", params, target(20000));
            assert.equal(response.error, null);
            await pool.waitForSubmits(1);
            const forwarded = pool.submits.find(item => item.message.params[1] === oldJobId);
            assert.ok(forwarded, "previous native KawPow share was not forwarded");
            assert.deepEqual(forwarded.message.params.slice(1), params.slice(1));
            assert.equal(forwarded.message.result, target(20000));
        }, nativeOptions);
    });

    test("an upstream disconnect invalidates the old native job before local low-diff acceptance", async () => {
        await withProxy(async ({ addMiner, pool, config }) => {
            const miner = await addMiner("native-disconnect+1000", nativeCapabilities(["kawpow"]));
            await waitForInitialGetjob(pool, miner);
            const prefix = await subscribe(miner, "disconnect-subscribe");
            const oldJobId = "disconnect-old-kawpow";
            pool.push(pool.connections[0], "kawpow", oldJobId);
            await notify(miner, oldJobId);
            const params = nativeParams("kawpow", "native-disconnect", oldJobId, prefix);

            const local = await submitNative(miner, "before-disconnect", params, target(2000));
            assert.equal(local.error, null);
            assert.equal(pool.submits.length, 0);

            pool.connections[0].peer.close();
            await pool.waitForLogins(2);
            const reconnect = pool.logins.at(-1);
            assert.ok(reconnect.job, "reconnect login has a generated job");
            await miner.peer.waitForMessage(
                message => message.method === "job" && message.params && message.params.job_id === reconnect.job.job_id,
                config.timeoutMs, "reconnect job delivery");

            const stale = await submitNative(miner, "after-disconnect", params, target(2000));
            assert.ok(stale.error, "old job cannot receive a local low-difficulty acceptance");
            assert.equal(pool.submits.length, 0);
        }, nativeOptions);
    });

    test("fixed ETH and Ergo clients receive controls only after subscribe-first authorization", async () => {
        for (const algo of ["ethash", "autolykos2"]) {
            await withProxy(async ({ miners, proxyPort, config }) => {
                const miner = new FakeMiner(`fixed-${algo}`, proxyPort, config.timeoutMs);
                miners.push(miner);
                await miner.connect();
                miner.peer.send({ id: "fixed-subscribe", method: "mining.subscribe",
                    params: ["offline-fixed"] });
                const subscription = await miner.peer.waitForMessage(
                    message => message.id === "fixed-subscribe",
                    config.timeoutMs, `${algo} fixed subscription`);
                assert.equal(subscription.error, null);
                assert.match(subscription.result[1], /^abcd[0-9a-f]{2}$/i);
                assert.equal(subscription.result.length, algo === "ethash" ? 2 : 3,
                    `${algo} subscription result width`);
                if (algo === "autolykos2") assert.equal(subscription.result[2], 5);
                assert.equal(miner.peer.messages.filter(message =>
                    message.method === "mining.set_difficulty" || message.method === "mining.notify").length, 0,
                `${algo} sent no work before authorization`);

                miner.peer.send({ id: "fixed-authorize", method: "mining.authorize",
                    params: [`fixed-${algo}`, "x"] });
                const authorization = await miner.peer.waitForMessage(
                    message => message.id === "fixed-authorize",
                    config.timeoutMs, `${algo} fixed authorization`);
                assert.equal(authorization.error, null);
                assert.equal(authorization.result, true);

                const job = await miner.peer.waitForMessage(
                    message => message.method === "mining.notify" && message.params &&
                        String(message.params[0]).startsWith("fixed-"),
                    config.timeoutMs, `${algo} fixed notify`);
                const messages = miner.peer.messages;
                const controlIndex = messages.findIndex(message =>
                    message.method === "mining.set_difficulty" && message.algo === algo);
                const notifyIndex = messages.indexOf(job);
                assert.ok(controlIndex >= 0 && controlIndex < notifyIndex,
                    `${algo} difficulty control precedes notify`);
                assert.equal(job.algo, algo);
                assert.equal(job.params.length, algo === "ethash" ? 4 : 9);
            }, {
                poolFactory: timeout => new FixedNativePool(timeout, algo),
                proxyArgs: [`--algo=${algo}`]
            });
        }
    });
});
