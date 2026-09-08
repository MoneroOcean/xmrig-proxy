"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { CAPABILITIES, FakeMiner, FakePool, delay, waitFor, withProxy } = require("./common/proxy_harness.js");
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

class DelayedGpuOnlyPool extends GpuOnlyPool {
    constructor(timeoutMs) {
        super(timeoutMs);
        this.pendingInitialLogin = null;
    }

    onMessage(connection, message) {
        if (message.method === "login" && this.logins.length === 0) {
            const job = Object.assign(this.nextJob(), {
                algo: "rx/0",
                seed_hash: "34".repeat(32)
            });
            this.logins.push({ at: Date.now(), connection, message, job });
            this.pendingInitialLogin = { connection, message, job };
            return;
        }

        return super.onMessage(connection, message);
    }

    releaseInitialLogin() {
        assert.ok(this.pendingInitialLogin, "initial upstream login was not held");
        const { connection, message, job } = this.pendingInitialLogin;
        this.pendingInitialLogin = null;
        connection.peer.send({ id: message.id, jsonrpc: "2.0", error: null,
            result: { id: connection.rpcId, job, extensions: ["algo", "keepalive"] } });
    }
}

class BudgetChurnPool extends GpuOnlyPool {
    constructor(timeoutMs) {
        super(timeoutMs);
        this.getjobTrace = [];
    }

    onMessage(connection, message) {
        if (message.method === "getjob") {
            this.getjobTrace.push({
                at: Date.now(),
                connection_id: connection.id,
                offered_algos: Array.isArray(message.params && message.params.algo)
                    ? [...message.params.algo] : []
            });
        }

        return super.onMessage(connection, message);
    }
}

function scaledBaseCapabilities(factor) {
    return {
        algos: [...CAPABILITIES.base.algos],
        perfs: Object.fromEntries(Object.entries(CAPABILITIES.base.perfs)
            .map(([algo, perf]) => [algo, perf * factor]))
    };
}

async function closeFakeMiner(miner) {
    if (!miner || !miner.peer || miner.peer.closed) {
        miner?.close();
        return;
    }

    const closed = new Promise(resolve => miner.peer.once("closed", resolve));
    miner.close();
    await closed;
}

function startCpuChurn(addMiner, factors) {
    const state = {
        started_at: Date.now(),
        completed: 0,
        stopped: false,
        error: null,
        finished_at: null
    };
    const promise = (async () => {
        try {
            while (!state.stopped && Date.now() - state.started_at < 6000 && state.completed < 200) {
                const factor = factors[state.completed % 4];
                const miner = await addMiner(`churn-${state.completed}-${factor}`, scaledBaseCapabilities(factor));
                await closeFakeMiner(miner);
                state.completed++;
                await delay(75);
            }
        }
        catch (error) {
            state.error = error?.message || String(error);
        }
        finally {
            state.finished_at = Date.now();
        }
    })();

    return {
        state,
        promise,
        stop() {
            state.stopped = true;
        }
    };
}

async function runGetjobBudgetScenario(withChurn) {
    const state = {
        variant: withChurn ? "churn" : "control",
        status: "running",
        anchor_factors: [1, 10, 100, 1000, 10000, 100000],
        getjob_trace: []
    };

    try {
        await withProxy(async ({ addMiner, miners, proxyPort, config, pool }) => {
            const anchors = [];
            for (const factor of state.anchor_factors) {
                anchors.push(await addMiner(`anchor-${factor}`, scaledBaseCapabilities(factor)));
            }

            await pool.waitForLogins(state.anchor_factors.length);
            assert.equal(pool.logins.length, state.anchor_factors.length,
                "six scaled CPU anchors did not form six upstream groups");

            if (withChurn) {
                await delay(1100);
            }

            const churn = withChurn ? startCpuChurn(addMiner, state.anchor_factors) : null;
            state.churn_started_at = churn?.state.started_at ?? null;
            try {
                if (churn) {
                    await waitFor(() => churn.state.error || pool.getjobTrace.filter(entry =>
                        entry.at >= churn.state.started_at && Date.now() - entry.at < 1000).length >= 4,
                    3000, "four recent churn getjob requests");
                    assert.equal(churn.state.error, null, "CPU churn failed");
                    state.pre_target_window = pool.getjobTrace.filter(entry =>
                        entry.at >= churn.state.started_at && Date.now() - entry.at < 1000);
                    assert.ok(state.pre_target_window.length >= 4,
                        "target was not queued behind four recent getjob requests");
                }

                await closeFakeMiner(anchors.at(-1));
                const gpu = new FakeMiner("churn-gpu-kawpow1", proxyPort, config.timeoutMs);
                miners.push(gpu);
                await gpu.connect();
                const targetSentAt = Date.now();
                gpu.peer.send({ id: 1, jsonrpc: "2.0", method: "login", params: {
                    login: "churn-gpu-kawpow1",
                    pass: "x",
                    agent: "offline-getjob-budget",
                    algo: ["kawpow1"],
                    "algo-perf": { kawpow1: 1 },
                    extensions: ["mo-native", "submit-result"]
                } });

                await waitFor(() => pool.getjobTrace.some(entry =>
                    entry.at >= targetSentAt && entry.offered_algos.includes("kawpow1")),
                5000, "GPU KawPow getjob under budget churn");
                const targetRequest = pool.getjobTrace.find(entry =>
                    entry.at >= targetSentAt && entry.offered_algos.includes("kawpow1"));
                state.target_getjob_at = targetRequest.at;
                state.target_getjob_latency_ms = targetRequest.at - targetSentAt;
                state.target_request = targetRequest;

                const login = await gpu.peer.waitForMessage(message => message.id === 1,
                    5000, "GPU KawPow budget login response");
                assert.equal(login.error, null);
                assert.equal(login.result.algo, "kawpow");
                assert.equal(login.result.status, "OK");

                await gpu.peer.waitForMessage(message =>
                    message.method === "mining.set_target" && message.algo === "kawpow",
                5000, "GPU KawPow budget control");
                await gpu.peer.waitForMessage(message =>
                    message.method === "mining.notify" && message.algo === "kawpow",
                5000, "GPU KawPow budget native job");
                state.target_job_at = Date.now();
                state.target_job_latency_ms = state.target_job_at - targetSentAt;
                assert.ok(state.target_job_latency_ms <= 5000,
                    "GPU KawPow native job exceeded five-second budget");
                if (churn) {
                    assert.ok(state.target_job_at <= churn.state.started_at + 6000,
                        "GPU KawPow native job arrived after churn ended");
                }
            }
            finally {
                if (churn) {
                    churn.stop();
                    await churn.promise;
                    state.churn_completed = churn.state.completed;
                    state.churn_finished_at = churn.state.finished_at;
                    state.churn_error = churn.state.error;
                }
                state.upstream_logins = pool.logins.length;
                state.getjob_trace = [...pool.getjobTrace];
            }
        }, {
            poolFactory: timeout => new BudgetChurnPool(timeout)
        });
        state.status = "pass";
    }
    catch (error) {
        state.status = "fail";
        state.error = error?.message || String(error);
        throw error;
    }
    finally {
        process.stdout.write(`GETJOB_BUDGET_RESULT ${JSON.stringify(state)}\n`);
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

for (const scenario of [
    { requested: "kawpow1", algorithm: "kawpow", control: "mining.set_target" },
    { requested: "autolykos2", algorithm: "autolykos2", control: "mining.set_difficulty" }
]) {
    test(`delayed RX/0 login refreshes GPU-only ${scenario.requested} capability`, async () => {
        await withProxy(async ({ miners, proxyPort, config, pool }) => {
            const miner = new FakeMiner(`delayed-gpu-${scenario.requested}`, proxyPort, config.timeoutMs);
            miners.push(miner);
            await miner.connect();
            miner.peer.send({ id: 1, jsonrpc: "2.0", method: "login", params: {
                login: `delayed-gpu-${scenario.requested}`,
                pass: "x",
                agent: "offline-delayed-gpu",
                algo: [scenario.requested],
                "algo-perf": { [scenario.requested]: 1 },
                extensions: ["mo-native", "submit-result"]
            } });

            await new Promise(resolve => setTimeout(resolve, 50));
            assert.equal(pool.logins.length, 1, "downstream capability stayed on the pending upstream client");
            assert.equal(pool.getjobs.length, 0, "getjob waits for the delayed login response");

            pool.releaseInitialLogin();
            await pool.waitForGetjobs(1);
            const request = pool.getjobs.at(-1).message;
            assert.deepEqual(request.params.algo, [scenario.requested]);
            assert.deepEqual(Object.keys(request.params["algo-perf"]), [scenario.requested]);

            const login = await miner.peer.waitForMessage(message => message.id === 1,
                config.timeoutMs, `${scenario.requested} delayed login response`);
            assert.equal(login.error, null);
            assert.equal(login.result.algo, scenario.algorithm);
            assert.equal(login.result.status, "OK");
            assert.equal(login.result.job, undefined);

            const extraNonce = await miner.peer.waitForMessage(message =>
                message.method === "mining.set_extranonce", config.timeoutMs,
                `${scenario.requested} delayed extranonce`);
            assert.deepEqual(extraNonce.params, [login.result.extra_nonce, 5]);
            const control = await miner.peer.waitForMessage(message =>
                message.method === scenario.control && message.algo === scenario.algorithm,
                config.timeoutMs, `${scenario.requested} delayed control`);
            assert.deepEqual(control.params, pool.nativeMessages[0].params);
            const notify = await miner.peer.waitForMessage(message =>
                message.method === "mining.notify" && message.algo === scenario.algorithm,
                config.timeoutMs, `${scenario.requested} delayed notify`);
            assert.deepEqual(notify.params, pool.nativeMessages[1].params);
        }, {
            poolFactory: timeout => new DelayedGpuOnlyPool(timeout)
        });
    });
}

test("getjob budget control forwards GPU-only KawPow after six CPU groups", async () => {
    await runGetjobBudgetScenario(false);
});

test("getjob budget churn forwards GPU-only KawPow while four groups are busy", async () => {
    await runGetjobBudgetScenario(true);
});
