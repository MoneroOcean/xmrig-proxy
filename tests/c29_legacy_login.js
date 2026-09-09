"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { withProxy } = require("./common/proxy_harness.js");
const { NativePool, fixture } = require("./common/native_fixtures.js");

class C29NativePool extends NativePool {
    onMessage(connection, message) {
        if (message.method !== "getjob" || !message.params || !Array.isArray(message.params.algo) ||
            !message.params.algo.includes("c29")) {
            return super.onMessage(connection, message);
        }

        const job = fixture("c29", "initial-c29", "grin", connection.rpcId).at(-1).params;
        this.getjobs.push({ connection, message, job });
        const metadata = {
            id: connection.rpcId,
            extra_nonce: "abcd",
            extensions: ["algo", "keepalive", "mo-native", "submit-result"]
        };
        connection.peer.send({ id: message.id, error: null, result: Object.assign(metadata, job) });
    }
}

const nativePoolOptions = { poolFactory: timeout => new C29NativePool(timeout) };

function legacyLogin(agent = "lolMiner 1.98a") {
    return { params: { agent } };
}

function loginResponse(miner) {
    const response = miner.peer.messages.find(message => message.id === 1);
    assert.ok(response && response.result, "missing downstream login response");
    return response;
}

function assertNormalJob(login, label) {
    assert.equal(login.result.extensions.includes("mo-native"), false, `${label} is native`);
    assert.equal(login.result.job.pre_pow, undefined, `${label} unexpectedly has C29 pre_pow`);
    assert.equal(login.result.job.difficulty, undefined, `${label} unexpectedly has C29 difficulty`);
    assert.ok(login.result.job.blob, `${label} has no normal blob`);
}

test.describe("legacy lolMiner C29 login", { concurrency: false }, () => {
    test("plain login on configured C29 requests and forwards native object jobs", async () => {
        await withProxy(async ({ addMiner, pool }) => {
            const miner = await addMiner("legacy-c29", legacyLogin());
            await pool.waitForGetjobs(1);

            const request = pool.getjobs.at(-1);
            assert.ok(request.message.params.algo.includes("c29"), "C29 capability was not requested upstream");

            const login = loginResponse(miner);
            const downstreamId = login.result.id;
            const expectedInitial = fixture("c29", "initial-c29", "grin", request.connection.rpcId).at(-1).params;
            assert.equal(login.result.algo, "c29");
            assert.equal(login.result.job.pre_pow, expectedInitial.pre_pow);
            for (const [key, value] of Object.entries(expectedInitial)) {
                assert.deepEqual(login.result.job[key], key === "id" ? downstreamId : value, `initial ${key}`);
            }
            assert.notEqual(login.result.job.id, request.connection.rpcId, "initial C29 job retained upstream ID");

            const pushedId = "pushed-c29";
            pool.push(request.connection, "c29", pushedId, "grin");
            const pushed = await miner.waitForJob(job => job.job_id === pushedId, "pushed C29 object job");
            const expectedPushed = fixture("c29", pushedId, "grin", request.connection.rpcId).at(-1).params;
            assert.deepEqual(pushed, Object.assign({}, expectedPushed, { id: downstreamId }));
            assert.notEqual(pushed.id, request.connection.rpcId, "pushed C29 job retained upstream ID");

            miner.peer.send({ id: "plain-submit", method: "submit", params: {
                id: downstreamId, job_id: pushedId, nonce: 7,
                pow: Array.from({ length: pushed.proofsize }, (_, i) => i + 1)
            } });
            const reply = await miner.peer.waitForMessage(message => message.id === "plain-submit",
                miner.timeoutMs, "plain C29 submit reply");
            assert.equal(reply.error, null);
            assert.equal(reply.result, true, "plain C29 client requires a boolean acceptance");
            assert.equal(pool.submits.length, 1, "share must be forwarded, not accepted locally");
        }, Object.assign({}, nativePoolOptions, { proxyArgs: ["--algo=c29"] }));
    });

    test("explicit MO-native C29 capabilities retain status-object submit replies", async () => {
        await withProxy(async ({ addMiner, pool }) => {
            const miner = await addMiner("native-c29", {
                algos: ["c29"],
                params: { extensions: ["algo", "keepalive", "mo-native"] }
            });
            await pool.waitForGetjobs(1);

            const request = pool.getjobs.at(-1);
            assert.ok(request.message.params.algo.includes("c29"), "explicit C29 was not requested upstream");
            const login = loginResponse(miner);
            assert.equal(login.result.algo, "c29");
            assert.equal(login.result.status, "OK");
            assert.equal(login.result.extensions.includes("submit-result"), false,
                "explicit client unexpectedly negotiated submit-result");
            const job = login.result.job;
            assert.ok(job, "missing explicit C29 object job");

            miner.peer.send({ id: "native-status-submit", method: "submit", params: {
                id: login.result.id, job_id: job.job_id, nonce: 7,
                pow: Array.from({ length: job.proofsize }, (_, i) => i + 1)
            } });
            const reply = await miner.peer.waitForMessage(message => message.id === "native-status-submit",
                miner.timeoutMs, "explicit C29 submit reply");
            assert.equal(reply.error, null);
            assert.deepEqual(reply.result, { status: "OK" }, "explicit C29 requires a status object");
            assert.equal(pool.submits.length, 1, "explicit C29 share must be forwarded");
        }, Object.assign({}, nativePoolOptions, { proxyArgs: ["--algo=c29"] }));
    });

    test("plain login on configured RX remains a normal nonnative session", async () => {
        await withProxy(async ({ addMiner, pool }) => {
            const miner = await addMiner("legacy-rx", legacyLogin());
            await pool.waitForGetjobs(1);

            const request = pool.getjobs.at(-1);
            assert.equal(request.message.params.algo.includes("c29"), false, "RX session requested C29");
            const login = loginResponse(miner);
            assertNormalJob(login, "RX login");
            assert.equal(login.result.job.algo, "cn-heavy/xhv");
        }, Object.assign({}, nativePoolOptions, { proxyArgs: ["--algo=rx/0"] }));
    });

    test("explicit RX capabilities are not overridden by configured C29", async () => {
        await withProxy(async ({ addMiner, pool }) => {
            const miner = await addMiner("explicit-rx", Object.assign({}, legacyLogin(), { algos: ["rx/0"] }));
            await pool.waitForGetjobs(1);

            const request = pool.getjobs.at(-1);
            assert.deepEqual(request.message.params.algo, ["rx/0"]);
            const login = loginResponse(miner);
            assertNormalJob(login, "explicit RX login");
            assert.equal(login.result.job.algo, "cn-heavy/xhv");
        }, Object.assign({}, nativePoolOptions, { proxyArgs: ["--algo=c29"] }));
    });
});
