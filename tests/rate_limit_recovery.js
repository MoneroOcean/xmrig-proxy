"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
    CAPABILITIES,
    delay,
    FakePool,
    waitFor,
    withProxy
} = require("./common/proxy_harness.js");

const UNSUPPORTED_ALGO_ERROR = "algo array must include at least one supported pool algo: no matching work";
const RESTRICTIVE_CAPABILITIES = {
    algos: ["rx/0"],
    perfs: { "rx/0": 1000 }
};

class NullGetjobPool extends FakePool {
    constructor(timeoutMs, options = {}) {
        super(timeoutMs, options);
        this.nullGetjobs = 0;
    }

    onMessage(connection, message) {
        if (message.method !== "getjob" || this.nullGetjobs > 0) {
            super.onMessage(connection, message);
            return;
        }

        const job = this.nextJob();
        this.getjobs.push({ at: Date.now(), connection, message, job });
        ++this.nullGetjobs;

        const respond = () => connection.peer.send({
            id: message.id,
            jsonrpc: "2.0",
            error: null,
            result: null
        });

        if (this.options.getjobDelayMs) {
            setTimeout(respond, this.options.getjobDelayMs);
        }
        else {
            respond();
        }
    }
}

class AlgoRejectPool extends FakePool {
    constructor(timeoutMs, options = {}) {
        super(timeoutMs, options);
        this.rejectedGetjobs = 0;
    }

    onMessage(connection, message) {
        if (message.method !== "getjob" || this.rejectedGetjobs >= (this.options.rejectGetjobs || 0)) {
            super.onMessage(connection, message);
            return;
        }

        const job = this.nextJob();
        this.getjobs.push({ at: Date.now(), connection, message, job });
        ++this.rejectedGetjobs;

        const respond = () => connection.peer.send({
            id: message.id,
            jsonrpc: "2.0",
            error: { code: -1, message: UNSUPPORTED_ALGO_ERROR },
            result: null
        });

        if (this.options.getjobDelayMs) {
            setTimeout(respond, this.options.getjobDelayMs);
        }
        else {
            respond();
        }
    }
}

test.describe("upstream request pacing and reconnect recovery", { concurrency: false }, () => {
    test("coalesces capability changes while an ID-1 getjob response is in flight", async () => {
        await withProxy(async ({ addMiner, pool }) => {
            await addMiner("miner-base", CAPABILITIES.base);
            const secondMiner = addMiner("miner-superset", CAPABILITIES.superset);

            await pool.waitForGetjobs(2);
            await secondMiner;

            assert.equal(pool.logins.length, 1, "getjob response must not be replayed as login success");
            assert.equal(pool.getjobs.length, 2, "capability changes should be coalesced into one follow-up getjob");
        }, {
            poolOptions: { getjobDelayMs: 250 }
        });
    });

    test("retries a queued capability refresh after a null getjob result", async () => {
        await withProxy(async ({ addMiner, pool }) => {
            const firstMiner = await addMiner("miner-null-base", CAPABILITIES.base);
            const initialJob = firstMiner.lastJob;
            const secondMiner = addMiner("miner-null-superset", CAPABILITIES.superset);

            await pool.waitForGetjobs(2);
            await secondMiner;

            await firstMiner.peer.waitForMessage(
                message => message.method === "job"
                    && message.params
                    && message.params.job_id === pool.getjobs[1].job.job_id,
                firstMiner.timeoutMs,
                "queued getjob job notification"
            );

            assert.equal(pool.nullGetjobs, 1, "the first getjob response must be null");
            assert.equal(pool.logins.length, 1, "null getjob response must not replay upstream login");
            assert.equal(
                firstMiner.peer.messages.filter(message => message.id === 1).length,
                1,
                "null getjob response must not create another miner login response"
            );
            assert.equal(
                firstMiner.lastJob.job_id,
                pool.getjobs[1].job.job_id,
                "the queued getjob must refresh the existing job after null response"
            );
            assert.notEqual(firstMiner.lastJob.job_id, initialJob.job_id, "follow-up getjob should deliver a refreshed job");
        }, {
            poolFactory: (timeoutMs, options) => new NullGetjobPool(timeoutMs, options),
            poolOptions: { getjobDelayMs: 250 }
        });
    });

    test("suppresses repeated identical unsupported-algo getjob retries during cooldown", async () => {
        await withProxy(async ({ addMiner, config, pool, proxy }) => {
            await addMiner("miner-rejected", CAPABILITIES.base);
            await pool.waitForGetjobs(1);
            await waitFor(
                () => proxy.output.join("").includes(UNSUPPORTED_ALGO_ERROR),
                config.timeoutMs,
                "unsupported-algo rejection"
            );
            const churnMiner = addMiner("miner-rejected-churn", CAPABILITIES.superset);
            await churnMiner;
            await delay(400);

            assert.equal(pool.rejectedGetjobs, 1, "the same rejected algo array must not churn getjob requests");
            assert.equal(pool.getjobs.length, 1, "the cooldown must suppress duplicate getjobs");
            assert.equal(pool.logins.length, 1, "a capability rejection must not reconnect the upstream");
        }, {
            poolFactory: (timeoutMs, options) => new AlgoRejectPool(timeoutMs, options),
            poolOptions: { rejectGetjobs: 100 }
        });
    });

    test("retries immediately when the rejected request is superseded by a changed algo array", async () => {
        await withProxy(async ({ addMiner, pool }) => {
            const firstMiner = await addMiner("miner-rejected-base", CAPABILITIES.base);
            await pool.waitForGetjobs(1);

            const secondMiner = addMiner("miner-recovered-restrictive", RESTRICTIVE_CAPABILITIES);
            await pool.waitForGetjobs(2);
            await secondMiner;

            assert.equal(pool.rejectedGetjobs, 1, "only the original algo array should be rejected");
            assert.notDeepEqual(
                pool.getjobs[0].message.params.algo,
                pool.getjobs[1].message.params.algo,
                "the changed algo array must bypass the rejection cooldown"
            );
            await firstMiner.peer.waitForMessage(
                message => message.method === "job"
                    && message.params
                    && message.params.job_id === pool.getjobs[1].job.job_id,
                firstMiner.timeoutMs,
                "recovered getjob notification"
            );
        }, {
            poolFactory: (timeoutMs, options) => new AlgoRejectPool(timeoutMs, options),
            poolOptions: { rejectGetjobs: 1, getjobDelayMs: 250 }
        });
    });

    test("keeps ordinary getjob errors from creating a retry loop", async () => {
        await withProxy(async ({ addMiner, config, pool, proxy }) => {
            await addMiner("miner-ordinary-error", CAPABILITIES.base);
            await pool.waitForGetjobs(1);
            await waitFor(
                () => proxy.output.join("").includes("temporary getjob failure"),
                config.timeoutMs,
                "ordinary getjob error"
            );
            const secondMiner = addMiner("miner-ordinary-error-repeat", CAPABILITIES.superset);
            await pool.waitForGetjobs(2);
            await secondMiner;
            await delay(400);

            assert.equal(pool.getjobs.length, 2, "ordinary getjob errors keep the existing explicit-request behavior");
            assert.equal(pool.logins.length, 1, "ordinary getjob errors must not reconnect the upstream");
        }, {
            poolOptions: { getjobError: { code: -1, message: "temporary getjob failure" } }
        });
    });

    test("does not write queued getjobs after the pool closes the socket", async () => {
        await withProxy(async ({ addMiner, pool, proxy }) => {
            await addMiner("miner-close", CAPABILITIES.base);
            await pool.waitForGetjobs(1);
            await pool.waitForLogins(2);
            await delay(250);

            assert.equal(pool.getjobs.length, 1, "reconnect login should satisfy current capabilities");
            assert.doesNotMatch(proxy.output.join(""), /send failed, invalid state/);
        }, {
            poolOptions: { closeOnGetjob: true }
        });
    });
});
