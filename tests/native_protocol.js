"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { withProxy, assertSetEqual, FakeMiner } = require("./common/proxy_harness.js");
const { ALGORITHMS, NativePool, FixedNativePool, fixture, target } = require("./common/native_fixtures.js");

const capabilities = {
    algos: ALGORITHMS,
    perfs: Object.fromEntries(ALGORITHMS.map(algo => [algo, 100])),
    params: { extensions: ["mo-native", "submit-result"] }
};
const options = { poolFactory: timeout => new NativePool(timeout) };

function jobMessage(message, id) {
    return message.method === "job" && message.params.job_id === id ||
        message.method === "mining.notify" && message.params[0] === id ||
        message.method === "getjobtemplate" && message.result && message.result.job_id === id;
}

async function pushAndReceive(pool, miner, algo, id, profile) {
    pool.push(pool.connections[0], algo, id, profile);
    return miner.peer.waitForMessage(message => jobMessage(message, id), miner.timeoutMs, `${algo} ${id}`);
}

async function waitForInitialGetjob(pool, miner) {
    await pool.waitForGetjobs(1);
    const request = pool.getjobs.at(-1);
    assert.ok(request.job, "fake pool getjob has no generated job");
    await miner.peer.waitForMessage(
        message => message.method === "job" && message.params && message.params.job_id === request.job.job_id,
        miner.timeoutMs, "initial getjob delivery");
    return request.job;
}

test.describe("native MoneroOcean algorithms", { concurrency: false }, () => {
    test("opt-in advertises every pool algorithm, while legacy clients keep their old filter", async () => {
        await withProxy(async ({ addMiner, pool }) => {
            await addMiner("native-caps", capabilities);
            await pool.waitForGetjobs(1);
            const algos = pool.getjobs.at(-1).message.params.algo;
            assertSetEqual(algos.map(algo => algo === "kawpow1" ? "kawpow" : algo), ALGORITHMS, "all pool algorithms");
        }, options);
        await withProxy(async ({ addMiner, pool }) => {
            await addMiner("legacy-caps", { algos: ["rx/0", "kawpow", "kawpow1", "ethash", "c29"] });
            await pool.waitForGetjobs(1);
            assert.deepEqual(pool.getjobs.at(-1).message.params.algo, ["rx/0"]);
        }, options);
    });

    test("all registered algorithms retain their native job layouts", async () => {
        await withProxy(async ({ addMiner, pool }) => {
            const miner = await addMiner("native-layouts", capabilities);
            await waitForInitialGetjob(pool, miner);
            for (const algo of ALGORITHMS) {
                const id = `layout-${algo}`;
                const received = await pushAndReceive(pool, miner, algo, id);
                const expected = fixture(algo, id).at(-1);
                assert.equal(received.method, expected.method, algo);
                if (Array.isArray(expected.params)) {
                    assert.equal(received.algo, algo);
                    assert.deepEqual(received.params, expected.params, algo);
                }
                else {
                    for (const key of ["algo", "height", "seed_hash", "pre_pow", "proofsize", "noncebytes", "edgebits"])
                        if (key in expected.params) assert.deepEqual(received.params[key], expected.params[key], `${algo}.${key}`);
                }
            }
            for (const profile of ["xtmc", "tube"]) {
                const message = await pushAndReceive(pool, miner, "c29", `layout-${profile}`, profile);
                assert.equal(message.params.proofsize, profile === "xtmc" ? 42 : 40);
                assert.equal(message.params.noncebytes, profile === "xtmc" ? 8 : 4);
            }
        }, options);
    });

    test("every directed family switch emits the new job and algorithm marker", async () => {
        await withProxy(async ({ addMiner, pool }) => {
            const miner = await addMiner("native-switches", capabilities);
            await waitForInitialGetjob(pool, miner);
            const families = ["cn-heavy/xhv", "rx/0", "kawpow", "etchash", "ethash", "autolykos2", "c29"];
            let seq = 0;
            for (const from of families) for (const to of families) {
                if (from === to) continue;
                await pushAndReceive(pool, miner, from, `switch-${seq++}`);
                const message = await pushAndReceive(pool, miner, to, `switch-${seq++}`);
                assert.equal(message.algo || message.params.algo, to, `${from} -> ${to}`);
            }
        }, options);
    });

    test("string login and keepalive request IDs are preserved", async () => {
        await withProxy(async ({ miners, proxyPort, config }) => {
            const miner = new FakeMiner("native-string-ids", proxyPort, config.timeoutMs);
            miners.push(miner);
            await miner.connect();
            miner.peer.send({ id: "login-native", method: "login", params: {
                login: "native-string-ids", pass: "x", agent: "offline-native",
                algo: ["cn-heavy/xhv"], extensions: ["mo-native"]
            } });
            const login = await miner.peer.waitForMessage(message => message.id === "login-native",
                config.timeoutMs, "string login ID");
            assert.equal(login.error, null);
            assert.ok(login.result.extensions.includes("mo-native"));
            miner.peer.send({ id: "mm", method: "keepalived", params: { id: login.result.id } });
            const pong = await miner.peer.waitForMessage(message => message.id === "mm",
                config.timeoutMs, "multi-miner keepalive ID");
            assert.equal(pong.error, null);
        }, options);
    });

    test("native subscribe and authorize receive a real nonce assignment", async () => {
        await withProxy(async ({ miners, proxyPort, config }) => {
            const miner = new FakeMiner("native-subscribe", proxyPort, config.timeoutMs);
            miners.push(miner);
            await miner.connect();
            miner.peer.send({ id: "subscribe", method: "mining.subscribe", params: ["offline-native"] });
            const subscription = await miner.peer.waitForMessage(message => message.id === "subscribe",
                config.timeoutMs, "native subscription");
            assert.equal(subscription.error, null);
            assert.match(subscription.result[1], /^abcd[0-9a-f]{2}$/i);
            assert.equal(subscription.result[2], 5);
            assert.equal(miner.peer.messages.filter(message => message.method === "mining.notify").length, 0,
                "subscription reserves a nonce without authorizing work");
            miner.peer.send({ id: "authorize", method: "mining.authorize", params: ["native-subscribe", "x"] });
            const authorization = await miner.peer.waitForMessage(message => message.id === "authorize",
                config.timeoutMs, "native authorization");
            assert.equal(authorization.error, null);
            assert.equal(authorization.result, true);
            const job = await miner.peer.waitForMessage(message => message.method === "mining.notify",
                config.timeoutMs, "fixed KawPow job");
            assert.equal(job.algo, "kawpow");
            assert.equal(job.params.length, 7);
        }, { poolFactory: timeout => new FixedNativePool(timeout, "kawpow"), proxyArgs: ["--algo=kawpow"] });
    });

    test("native reservation does not bypass the configured access password", async () => {
        await withProxy(async ({ miners, proxyPort, config }) => {
            const miner = new FakeMiner("native-denied", proxyPort, config.timeoutMs);
            miners.push(miner);
            await miner.connect();
            miner.peer.send({ id: "reserve", method: "mining.subscribe", params: ["offline-native"] });
            const subscription = await miner.peer.waitForMessage(message => message.id === "reserve",
                config.timeoutMs, "unauthenticated nonce reservation");
            assert.equal(subscription.error, null);
            miner.peer.send({ id: "denied", method: "mining.authorize", params: ["native-denied", "wrong"] });
            const denied = await miner.peer.waitForMessage(message => message.id === "denied",
                config.timeoutMs, "native access rejection");
            assert.ok(denied.error);
            assert.equal(miner.peer.messages.filter(message => message.method === "mining.notify").length, 0);
        }, { poolFactory: timeout => new FixedNativePool(timeout, "kawpow"),
            proxyArgs: ["--algo=kawpow", "--access-password=secret"] });
    });

    test("hashless native clients keep pool difficulty and forward their native shares", async () => {
        await withProxy(async ({ addMiner, pool, config }) => {
            const miner = await addMiner("native-hashless+1000", Object.assign({}, capabilities, {
                algos: ["cn-heavy/xhv", "kawpow", "etchash", "ethash", "autolykos2"],
                perfs: {},
                params: { extensions: ["mo-native"] }
            }));
            await waitForInitialGetjob(pool, miner);
            miner.peer.send({ id: "late-subscribe", method: "mining.subscribe", params: ["offline-wrapper"] });
            const subscription = await miner.peer.waitForMessage(message => message.id === "late-subscribe",
                config.timeoutMs, "subscribe after object login");
            assert.equal(subscription.error, null);
            const prefix = subscription.result[1];
            assert.match(prefix, /^abcd[0-9a-f]{2}$/i);
            const nonce = prefix.padEnd(16, "0");
            for (const algo of ["kawpow", "etchash", "ethash", "autolykos2"]) {
                const id = `hashless-${algo}`;
                const job = await pushAndReceive(pool, miner, algo, id);
                assert.deepEqual(job.params, fixture(algo, id).at(-1).params, `${algo} pool target retained`);
                const params = ["native-hashless", id, `0x${nonce}`, `0x${"12".repeat(32)}`, `0x${"56".repeat(32)}`];
                miner.peer.send({ id, method: "mining.submit", params });
                const response = await miner.peer.waitForMessage(message => message.id === id,
                    config.timeoutMs, `${algo} share response`);
                assert.equal(response.error, null);
                const upstream = pool.submits.find(item => item.message.params[1] === id);
                assert.ok(upstream, `${algo} reached pool`);
                assert.equal(upstream.message.method, "mining.submit");
                assert.equal(upstream.message.params[2], params[2]);
                assert.equal(upstream.message.result, undefined);
            }
        }, options);
    });

    test("negotiated native hashes use miner and pool targets without changing submit arrays", async () => {
        await withProxy(async ({ addMiner, pool, config }) => {
            const miner = await addMiner("native-hashes+1000", {
                algos: ["cn-heavy/xhv", "kawpow"],
                params: { extensions: ["mo-native", "submit-result"] }
            });
            await waitForInitialGetjob(pool, miner);
            miner.peer.send({ id: "hash-subscribe", method: "mining.subscribe", params: ["offline-native"] });
            const subscribed = await miner.peer.waitForMessage(message => message.id === "hash-subscribe",
                config.timeoutMs, "hash-enabled subscription");
            const nonce = subscribed.result[1].padEnd(16, "0");
            const job = await pushAndReceive(pool, miner, "kawpow", "native-hash-job");
            assert.ok(BigInt(`0x${job.params[3]}`) > BigInt(`0x${fixture("kawpow", "native-hash-job").at(-1).params[3]}`));
            const params = ["native-hashes", "native-hash-job", `0x${nonce}`, `0x${"12".repeat(32)}`, `0x${"56".repeat(32)}`];
            const send = async (id, result, overrides = {}) => {
                miner.peer.send(Object.assign({ id, method: "mining.submit", params, result }, overrides));
                return miner.peer.waitForMessage(message => message.id === id, config.timeoutMs, `native hash ${id}`);
            };
            assert.ok((await send("below-miner", target(100))).error);
            assert.equal((await send("local-share", target(2000))).error, null);
            assert.equal(pool.submits.length, 0);
            assert.ok((await send("unknown-native-job", target(2000), { params: [params[0], "unknown", ...params.slice(2)] })).error);
            assert.ok((await send("missing-result", undefined)).error);
            assert.equal((await send("pool-share", target(20000))).error, null);
            assert.equal(pool.submits.length, 1);
            assert.deepEqual(pool.submits[0].message.params.slice(1), params.slice(1));
            assert.equal(pool.submits[0].message.result, target(20000));
        }, options);
    });

    test("native miners sharing an upstream receive distinct nonce prefixes", async () => {
        await withProxy(async ({ addMiner, pool, config }) => {
            const caps = { algos: ["cn-heavy/xhv", "kawpow"], params: { extensions: ["mo-native"] } };
            const first = await addMiner("native-slot-one", caps);
            const initial = await waitForInitialGetjob(pool, first);
            const second = await addMiner("native-slot-two", caps);
            const prefixes = [];
            for (const miner of [first, second]) {
                miner.peer.send({ id: "slot-subscribe", method: "mining.subscribe", params: ["offline-native"] });
                const reply = await miner.peer.waitForMessage(message => message.id === "slot-subscribe",
                    config.timeoutMs, "slot subscription");
                assert.equal(reply.error, null);
                prefixes.push(reply.result[1]);
            }
            assert.notEqual(prefixes[0], prefixes[1]);
            assert.equal(pool.logins.length, 1);
            pool.push(pool.connections[0], "kawpow", "native-slots");
            await Promise.all([first, second].map(miner => miner.peer.waitForMessage(
                message => jobMessage(message, "native-slots"), config.timeoutMs, "shared native job")));
            first.peer.send({ id: "wrong-slot", method: "mining.submit", params: ["native-slot-one",
                "native-slots", `0x${prefixes[1].padEnd(16, "0")}`, `0x${"12".repeat(32)}`, `0x${"56".repeat(32)}`] });
            const rejected = await first.peer.waitForMessage(message => message.id === "wrong-slot",
                config.timeoutMs, "wrong native slot rejection");
            assert.ok(rejected.error);
            assert.equal(pool.submits.length, 0);
        }, options);
    });

    test("the 257th partitionable native miner opens a second upstream", { timeout: 60000 }, async () => {
        await withProxy(async ({ addMiner, pool, config }) => {
            const caps = { algos: ["cn-heavy/xhv", "kawpow"], params: { extensions: ["mo-native"] } };
            const prefixes = new Set();
            for (let i = 0; i < 257; ++i) {
                const miner = await addMiner(`native-capacity-${i}`, caps);
                miner.peer.send({ id: "capacity-subscribe", method: "mining.subscribe", params: ["offline-native"] });
                const reply = await miner.peer.waitForMessage(message => message.id === "capacity-subscribe",
                    config.timeoutMs, `slot ${i}`);
                assert.equal(reply.error, null);
                assert.ok(!prefixes.has(reply.result[1]), `slot ${i} has unique pool+proxy prefix`);
                prefixes.add(reply.result[1]);
            }
            assert.equal(pool.logins.length, 2);
            assert.equal(prefixes.size, 257);
        }, options);
    });

    test("unpartitionable proof profiles use dedicated upstreams", async () => {
        await withProxy(async ({ addMiner, pool }) => {
            const caps = { algos: ["cn-heavy/xhv", "c29"], params: { extensions: ["mo-native"] } };
            await addMiner("proof-one", caps);
            await addMiner("proof-two", caps);
            await pool.waitForLogins(2);
            assert.equal(pool.logins.length, 2);
        }, options);
    });

    test("C29 proof submissions retain numeric and eight-byte nonce layouts", async () => {
        await withProxy(async ({ addMiner, pool, config }) => {
            const miner = await addMiner("proof-shares", {
                algos: ["cn-heavy/xhv", "c29"], params: { extensions: ["mo-native", "submit-result"] }
            });
            await waitForInitialGetjob(pool, miner);
            const login = miner.peer.messages.find(message => message.id === 1);
            for (const profile of ["grin", "tube", "xtmc"]) {
                const id = `proof-${profile}`;
                const job = (await pushAndReceive(pool, miner, "c29", id, profile)).params;
                const pow = Array.from({ length: job.proofsize }, (_, index) => index + 1);
                const nonce = profile === "xtmc" ? job.xn.padEnd(16, "0") : 7;
                miner.peer.send({ id, method: "submit", params: { id: login.result.id, job_id: id,
                    algo: "c29", nonce, pow, result: Buffer.from(target(20000), "hex").reverse().toString("hex") } });
                const reply = await miner.peer.waitForMessage(message => message.id === id, config.timeoutMs, `${profile} proof`);
                assert.equal(reply.error, null);
                const sent = pool.submits.find(item => item.message.params.job_id === id);
                assert.ok(sent);
                assert.equal(sent.message.params.nonce, nonce);
                assert.deepEqual(sent.message.params.pow, pow);
            }
        }, options);
    });
});
