"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
    CAPABILITIES,
    delay,
    withProxy
} = require("./common/proxy_harness.js");

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
