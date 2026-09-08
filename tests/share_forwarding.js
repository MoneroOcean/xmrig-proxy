"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { withProxy, delay } = require("./common/proxy_harness.js");

// Synthetic hashes exercise the proxy's existing trust model, without hashing.
function hashAtDifficulty(diff) {
    const tail = Buffer.alloc(8);
    tail.writeBigUInt64LE(((1n << 64n) - 1n) / BigInt(diff));
    return "00".repeat(24) + tail.toString("hex");
}

async function submit(miner, id, job, difficulty, overrides = {}) {
    const login = miner.peer.messages.find(message => message.id === 1);
    miner.peer.send({ id, method: "submit", params: Object.assign({
        id: login.result.id,
        job_id: job.job_id,
        nonce: job.blob.slice(78, 86),
        result: hashAtDifficulty(difficulty),
        algo: job.algo
    }, overrides) });
    return miner.peer.waitForMessage(message => message.id === id, miner.timeoutMs, `submit ${id}`);
}

test.describe("unmodified object-Stratum share compatibility", { concurrency: false }, () => {
    test("custom difficulty accepts intermediate shares locally and forwards pool shares", async () => {
        await withProxy(async ({ addMiner, pool }) => {
            const miner = await addMiner("legacy+1000", { algos: ["cn-heavy/xhv"] });
            const job = miner.lastJob;
            assert.equal((await submit(miner, 20, job, 100)).result, undefined);
            const local = await submit(miner, 21, job, 2000);
            assert.equal(local.error, null);
            assert.equal(local.result.status, "OK");
            await delay(50);
            assert.equal(pool.submits.length, 0);
            const forwarded = await submit(miner, 22, job, 20000);
            assert.equal(forwarded.error, null);
            await pool.waitForSubmits(1);
            assert.equal(pool.submits[0].message.params.job_id, job.job_id);
            assert.equal(pool.submits[0].message.params.result, hashAtDifficulty(20000));
        });
    });

    test("shared miners have distinct nonce slots and preserve native object payloads", async () => {
        await withProxy(async ({ addMiner, pool }) => {
            const first = await addMiner("legacy-one", { algos: ["cn-heavy/xhv"] });
            const second = await addMiner("legacy-two", { algos: ["cn-heavy/xhv"] });
            const job = pool.broadcastJob({ job_id: "shared-slots" })[0];
            const [a, b] = await Promise.all([
                first.waitForJob(value => value.job_id === job.job_id),
                second.waitForJob(value => value.job_id === job.job_id)
            ]);
            assert.notEqual(a.blob.slice(84, 86), b.blob.slice(84, 86));
            assert.equal((await submit(first, 30, a, 20000)).error, null);
            assert.equal((await submit(second, 31, b, 20000)).error, null);
            await pool.waitForSubmits(2);
            assert.equal(pool.logins.length, 1);
        });
    });

    test("unknown and expired jobs cannot obtain a local custom-difficulty acceptance", async () => {
        await withProxy(async ({ addMiner, pool }) => {
            const miner = await addMiner("legacy-stale+1000", { algos: ["cn-heavy/xhv"] });
            const original = miner.lastJob;
            const unknown = await submit(miner, 40, original, 2000, { job_id: "never-issued" });
            assert.ok(unknown.error, "unknown job rejected before local acceptance");
            for (const id of ["replacement-one", "replacement-two", "replacement-three"]) {
                pool.broadcastJob({ job_id: id });
                await miner.waitForJob(job => job.job_id === id);
            }
            assert.ok((await submit(miner, 41, original, 2000)).error, "expired job rejected");
            assert.equal(pool.submits.length, 0);
        });
    });

    test("the previous job retains its own pool target after a difficulty change", async () => {
        await withProxy(async ({ addMiner, pool }) => {
            const miner = await addMiner("legacy-previous+1000", { algos: ["cn-heavy/xhv"] });
            await pool.waitForGetjobs(1);
            const initial = pool.getjobs.at(-1).job;
            assert.ok(initial, "fake pool getjob has no generated job");
            await miner.peer.waitForMessage(
                message => message.method === "job" && message.params && message.params.job_id === initial.job_id,
                miner.timeoutMs, "initial legacy getjob delivery");
            pool.broadcastJob({ job_id: "previous-diff", target: "b88d0600" });
            const previous = await miner.waitForJob(job => job.job_id === "previous-diff");
            pool.broadcastJob({ job_id: "current-diff", target: "c5a70000" });
            await miner.waitForJob(job => job.job_id === "current-diff");
            assert.equal((await submit(miner, 50, previous, 20000)).error, null);
            await pool.waitForSubmits(1);
            assert.equal(pool.submits[0].message.params.job_id, "previous-diff");
        });
    });
});

module.exports = { hashAtDifficulty };
