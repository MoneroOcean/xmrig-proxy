"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { CAPABILITIES, FakeMiner, FakePool, withProxy } = require("./common/proxy_harness.js");
const { fixture } = require("./common/native_fixtures.js");

class GpuOnlyPool extends FakePool {
    constructor(timeoutMs) {
        super(timeoutMs);
        this.nativeMessages = [];
        this.requestedAlgos = null;
    }

    gpuAlgorithm(message) {
        const requested = Array.isArray(message.params && message.params.algo)
            ? [...message.params.algo] : [];
        this.requestedAlgos = requested;
        return requested.includes("kawpow1") || requested.includes("kawpow")
            ? "kawpow" : requested.includes("autolykos2") ? "autolykos2" : null;
    }

    sendNative(connection, algorithm) {
        this.nativeMessages = fixture(algorithm, "gpu-" + algorithm);
        if (algorithm === "kawpow") {
            this.nativeMessages[1].params[6] = "1d00ffff";
        }
        this.nativeMessages.forEach(nativeMessage => connection.peer.send(nativeMessage));
    }

    onMessage(connection, message) {
        if (message.method === "login") {
            const algorithm = this.gpuAlgorithm(message);
            if (this.logins.length === 0) {
                const job = Object.assign(this.nextJob(), {
                    algo: "rx/0",
                    seed_hash: "34".repeat(32)
                });
                this.logins.push({ at: Date.now(), connection, message, job });
                connection.peer.send({ id: message.id, jsonrpc: "2.0", error: null,
                    result: { id: connection.rpcId, job, extensions: ["algo", "keepalive"] } });
                return;
            }
            if (algorithm) {
                this.logins.push({ at: Date.now(), connection, message, job: undefined });
                connection.peer.send({ id: message.id, jsonrpc: "2.0", error: null,
                    result: { id: connection.rpcId, algo: algorithm, extra_nonce: "ff52",
                        extensions: ["algo", "keepalive", "mo-native", "submit-result"] } });
                this.sendNative(connection, algorithm);
                return;
            }
            return super.onMessage(connection, message);
        }

        if (message.method === "mining.subscribe") {
            connection.peer.send({ id: message.id, jsonrpc: "2.0", error: null,
                result: [["mining.notify", connection.rpcId, "EthereumStratum/1.0.0"], "ff52", 6] });
            return;
        }

        if (message.method === "getjob") {
            const algorithm = this.gpuAlgorithm(message);
            if (!algorithm) {
                return super.onMessage(connection, message);
            }
            this.getjobs.push({ at: Date.now(), connection, message });

            const metadata = {
                id: connection.rpcId,
                algo: algorithm,
                extra_nonce: "ff52",
                extensions: ["algo", "keepalive", "mo-native", "submit-result"]
            };
            connection.peer.send({ id: message.id, jsonrpc: "2.0", error: null, result: metadata });
            this.sendNative(connection, algorithm);
            return;
        }

        super.onMessage(connection, message);
    }
}

const scenarios = [
    { requested: "kawpow1", algorithm: "kawpow", control: "mining.set_target", occupiedCpu: false },
    { requested: "autolykos2", algorithm: "autolykos2", control: "mining.set_difficulty", occupiedCpu: false },
    { requested: "kawpow1", algorithm: "kawpow", control: "mining.set_target", occupiedCpu: true },
    { requested: "autolykos2", algorithm: "autolykos2", control: "mining.set_difficulty", occupiedCpu: true }
];

for (const scenario of scenarios) {
    test(`${scenario.occupiedCpu ? "active CPU miner" : "default proxy"} forwards GPU-only ${scenario.requested} native login`, async () => {
        await withProxy(async ({ addMiner, miners, proxyPort, config, pool }) => {
            if (scenario.occupiedCpu) {
                await addMiner(`cpu-before-${scenario.requested}`, CAPABILITIES.base);
            } else {
                assert.equal(pool.logins.length, 1);
                assert.equal(pool.logins[0].job.algo, "rx/0");
            }

            const miner = new FakeMiner(
                `${scenario.occupiedCpu ? "active-gpu" : "gpu-only"}-${scenario.requested}`,
                proxyPort, config.timeoutMs);
            miners.push(miner);
            await miner.connect();
            miner.peer.send({ id: 1, jsonrpc: "2.0", method: "login", params: {
                login: `${scenario.occupiedCpu ? "active-gpu" : "gpu-only"}-${scenario.requested}`,
                pass: "x",
                agent: "offline-gpu-only",
                algo: [scenario.requested],
                "algo-perf": { [scenario.requested]: 1 },
                extensions: ["mo-native", "submit-result"]
            } });

            if (scenario.occupiedCpu) {
                await pool.waitForLogins(2);
                assert.equal(pool.logins.length, 2);
                const gpuLogin = pool.logins[1];
                assert.deepEqual(gpuLogin.message.params.algo, [scenario.requested]);
                assert.deepEqual(Object.keys(gpuLogin.message.params["algo-perf"]),
                    [scenario.requested]);
            } else {
                await pool.waitForGetjobs(1);
                assert.deepEqual(pool.requestedAlgos, [scenario.requested]);
            }

            const login = await miner.peer.waitForMessage(message => message.id === 1,
                config.timeoutMs,
                `${scenario.requested} ${scenario.occupiedCpu ? "active" : "default"} login response`);
            assert.equal(login.error, null);
            assert.equal(login.result.algo, scenario.algorithm);
            assert.equal(login.result.status, "OK");
            assert.match(login.result.extra_nonce, /^ff52[0-9a-f]{2}$/i);
            assert.equal(login.result.job, undefined);

            const extraNonce = await miner.peer.waitForMessage(message =>
                message.method === "mining.set_extranonce", config.timeoutMs,
                `${scenario.requested} extranonce`);
            assert.deepEqual(extraNonce.params, [login.result.extra_nonce, 5]);

            const control = await miner.peer.waitForMessage(message =>
                message.method === scenario.control && message.algo === scenario.algorithm,
                config.timeoutMs, `${scenario.requested} control`);
            assert.deepEqual(control.params, pool.nativeMessages[0].params);

            const notify = await miner.peer.waitForMessage(message =>
                message.method === "mining.notify" && message.algo === scenario.algorithm,
                config.timeoutMs, `${scenario.requested} notify`);
            assert.deepEqual(notify.params, pool.nativeMessages[1].params);
            if (scenario.algorithm === "kawpow") {
                assert.equal(notify.params[6], "1d00ffff");
            }
        }, {
            poolFactory: timeout => new GpuOnlyPool(timeout)
        });
    });
}
