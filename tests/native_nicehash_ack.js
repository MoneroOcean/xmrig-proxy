"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { FakeMiner, withProxy } = require("./common/proxy_harness.js");
const { FixedNativePool, fixture } = require("./common/native_fixtures.js");

test("native initial KawPow login acknowledges NiceHash before a generic job", async () => {
    await withProxy(async ({ miners, proxyPort, config, pool }) => {
        const miner = new FakeMiner("native-kawpow-first", proxyPort, config.timeoutMs);
        miners.push(miner);
        await miner.connect();

        miner.peer.send({ id: 1, jsonrpc: "2.0", method: "login", params: {
            login: "native-kawpow-first",
            pass: "x",
            agent: "offline-native-kawpow",
            algo: ["cn-heavy/xhv", "kawpow"],
            "algo-perf": { "cn-heavy/xhv": 10, kawpow: 100 },
            extensions: ["mo-native"]
        } });

        const login = await miner.peer.waitForMessage(message => message.id === 1,
            config.timeoutMs, "native KawPow login response");
        assert.equal(login.error, null);
        assert.equal(login.result.algo, "kawpow");
        assert.equal(login.result.status, "OK");
        assert.ok(login.result.extensions.includes("nicehash"),
            "native initial login must acknowledge NiceHash negotiation");
        assert.match(login.result.extra_nonce, /^abcd[0-9a-f]{2}$/i);
        assert.equal(login.result.job, undefined);

        const extraNonce = await miner.peer.waitForMessage(message =>
            message.method === "mining.set_extranonce", config.timeoutMs,
            "native KawPow extranonce");
        assert.equal(extraNonce.algo, "kawpow");
        assert.deepEqual(extraNonce.params, [login.result.extra_nonce, 5]);

        const control = await miner.peer.waitForMessage(message =>
            message.method === "mining.set_target" && message.algo === "kawpow",
            config.timeoutMs, "native KawPow target");
        assert.deepEqual(control.params, fixture("kawpow", "fixed-1")[0].params);

        const notify = await miner.peer.waitForMessage(message =>
            message.method === "mining.notify" && message.algo === "kawpow" &&
            message.params && typeof message.params[0] === "string" &&
            message.params[0].startsWith("fixed-"),
            config.timeoutMs, "native KawPow notify");
        assert.deepEqual(notify.params, fixture("kawpow", notify.params[0])[1].params);

        const generic = pool.sendJob(pool.connections[0], { job_id: "generic-after-native" });
        const genericJob = await miner.peer.waitForMessage(message =>
            message.method === "job" && message.params &&
            message.params.job_id === generic.job_id, config.timeoutMs,
            "generic job after native job");
        assert.equal(genericJob.params.algo, "cn-heavy/xhv");
        assert.equal(genericJob.params.blob.slice(84, 86),
            login.result.extra_nonce.slice(-2).toLowerCase(),
            "generic CryptoNote job must reserve the negotiated trailing nonce byte");
    }, {
        poolFactory: timeout => new FixedNativePool(timeout, "kawpow"),
        proxyArgs: ["--algo=kawpow"]
    });
});
