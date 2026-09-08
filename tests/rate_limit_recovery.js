"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
    CAPABILITIES,
    delay,
    FakePool,
    withProxy
} = require("./common/proxy_harness.js");

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
