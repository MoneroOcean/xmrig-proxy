"use strict";

const { FakePool } = require("./proxy_harness.js");

const ALGORITHMS = ["rx/arq", "cn-heavy/xhv", "cn/gpu", "astrobwt/v2",
    "autolykos2", "etchash", "ethash", "flex", "argon2/chukwav2",
    "cn/half", "rx/0", "cn/r", "c29", "panthera", "ghostrider", "kawpow"];
const MAX = (1n << 256n) - 1n;
const target = difficulty => (MAX / BigInt(difficulty)).toString(16).padStart(64, "0");

// Real nodejs-pool wire layouts, with inert headers and synthetic targets.
function fixture(algo, id, profile) {
    const header = "12".repeat(32);
    const seed = "34".repeat(32);
    const baseParams = { job_id: id, algo, height: 1000,
        blob: "00".repeat(160), target: "b88d0600" };
    if (algo.startsWith("rx/") || algo === "panthera") baseParams.seed_hash = seed;
    const base = { method: "job", params: baseParams };
    if (algo === "kawpow") return [
        { method: "mining.set_target", params: [target(10000)], algo },
        { method: "mining.notify", algo, params: [id, header, seed, target(10000), true, 1000, 0x1d00ffff] }
    ];
    if (algo === "etchash" || algo === "ethash") return [
        { method: "mining.set_difficulty", params: [10000 / 0x100000000], algo },
        { method: "mining.notify", algo, params: [id, seed, header, true] }
    ];
    if (algo === "autolykos2") return [
        { method: "mining.set_difficulty", params: [1], algo },
        { method: "mining.notify", algo, params: [id, 1000, header, "", "", 2, (MAX / 10000n).toString(), "", true] }
    ];
    if (algo === "c29") {
        if (profile === "xtmc") {
            const compact = Buffer.alloc(8);
            compact.writeBigUInt64LE(((1n << 64n) - 1n) / 10000n);
            Object.assign(base.params, { algo: "cuckaroo", proofsize: 42, noncebytes: 8,
                nonceoffset: 0, xn: "abcd", target: compact.toString("hex") });
        }
        else {
            delete base.params.blob;
            delete base.params.target;
            Object.assign(base.params, { pre_pow: "00".repeat(120), edgebits: 29,
                proofsize: profile === "tube" ? 40 : 32, noncebytes: 4, difficulty: 10000 });
        }
    }
    return [base];
}

class NativePool extends FakePool {
    onMessage(connection, message) {
        const prefix = (0xabcc + connection.id).toString(16).padStart(4, "0");
        if (message.method === "login" || message.method === "getjob") {
            const job = this.nextJob();
            (message.method === "login" ? this.logins : this.getjobs).push({ connection, message, job });
            const metadata = { id: connection.rpcId, extra_nonce: prefix,
                extensions: ["algo", "keepalive", "mo-native", "submit-result"] };
            connection.peer.send({ id: message.id, error: null,
                result: message.method === "login" ? Object.assign(metadata, { job }) : Object.assign(metadata, job) });
            return;
        }
        if (message.method === "mining.subscribe") {
            connection.peer.send({ id: message.id, error: null,
                result: [["mining.notify", connection.rpcId, "EthereumStratum/1.0.0"], prefix, 6] });
            return;
        }
        if (message.method === "mining.submit") {
            this.submits.push({ connection, message });
            connection.peer.send({ id: message.id, error: null, result: true });
            return;
        }
        super.onMessage(connection, message);
    }

    push(connection, algo, id, profile) {
        for (const message of fixture(algo, id, profile)) connection.peer.send(message);
    }
}

class FixedNativePool extends NativePool {
    constructor(timeout, algo) { super(timeout); this.algo = algo; }

    onMessage(connection, message) {
        if (message.method !== "login" && message.method !== "getjob") return super.onMessage(connection, message);
        (message.method === "login" ? this.logins : this.getjobs).push({ connection, message });
        connection.peer.send({ id: message.id, error: null, result: {
            id: connection.rpcId, algo: this.algo, extra_nonce: "abcd",
            extensions: ["algo", "keepalive", "mo-native", "submit-result"]
        } });
        this.push(connection, this.algo, `fixed-${++this.jobSeq}`);
    }
}

module.exports = { ALGORITHMS, NativePool, FixedNativePool, fixture, target };
