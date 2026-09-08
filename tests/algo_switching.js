"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
    CAPABILITIES,
    DEFAULT_ALGOS,
    DEFAULT_PERFS,
    assertAlgoPayload,
    withProxy
} = require("./common/proxy_harness.js");

test.describe("MoneroOcean algo switching groups", { concurrency: false }, () => {
    test("compatible superset miner reuses the existing upstream and keeps the common algo set", async () => {
        await withProxy(async ({ addMiner, pool }) => {
            await addMiner("miner-base", CAPABILITIES.base);
            await pool.waitForGetjobs(1);
            assertAlgoPayload(pool.getjobs[0].message, CAPABILITIES.base.algos, CAPABILITIES.base.perfs, "base miner getjob");

            await addMiner("miner-superset", CAPABILITIES.superset);
            await pool.waitForGetjobs(2);

            assert.equal(pool.logins.length, 1, "superset miner should not open a second upstream");
            assertAlgoPayload(pool.getjobs[1].message, CAPABILITIES.base.algos, {
                "rx/0": 2000,
                "cn-heavy/xhv": 20
            }, "superset miner common getjob");
        });
    });

    test("restrictive miner added after a wider miner narrows the shared upstream capability set", async () => {
        await withProxy(async ({ addMiner, pool }) => {
            await addMiner("miner-superset", CAPABILITIES.superset);
            await pool.waitForGetjobs(1);
            assertAlgoPayload(pool.getjobs[0].message, CAPABILITIES.superset.algos, CAPABILITIES.superset.perfs, "wide miner getjob");

            await addMiner("miner-base", CAPABILITIES.base);
            await pool.waitForGetjobs(2);

            assert.equal(pool.logins.length, 1, "restrictive compatible miner should stay on the existing upstream");
            assertAlgoPayload(pool.getjobs[1].message, CAPABILITIES.base.algos, {
                "rx/0": 2000,
                "cn-heavy/xhv": 20
            }, "narrowed common getjob");
        });
    });

    test("algo-perf differences inside the configured threshold share one upstream", async () => {
        await withProxy(async ({ addMiner, pool }) => {
            await addMiner("miner-base", CAPABILITIES.base);
            await pool.waitForGetjobs(1);

            const near = {
                algos: ["rx/0", "cn-heavy/xhv"],
                perfs: {
                    "rx/0": 1150,
                    "cn-heavy/xhv": 11
                }
            };

            await addMiner("miner-near", near);
            await pool.waitForGetjobs(2);

            assert.equal(pool.logins.length, 1, "near algo-perf values should share the existing upstream");
            assertAlgoPayload(pool.getjobs[1].message, CAPABILITIES.base.algos, {
                "rx/0": 2150,
                "cn-heavy/xhv": 21
            }, "near-threshold common getjob");
        });
    });

    test("algo-perf outlier opens a separate upstream", async () => {
        await withProxy(async ({ addMiner, pool }) => {
            await addMiner("miner-base", CAPABILITIES.base);
            await pool.waitForGetjobs(1);

            const outlier = {
                algos: ["rx/0", "cn-heavy/xhv"],
                perfs: {
                    "rx/0": 2500,
                    "cn-heavy/xhv": 10
                }
            };

            await addMiner("miner-outlier", outlier);
            await pool.waitForLogins(2);

            assertAlgoPayload(pool.logins[1].message, outlier.algos, outlier.perfs, "outlier upstream login");
        });
    });

    test("miners with the same unknown performances share one upstream", async () => {
        await withProxy(async ({ addMiner, pool }) => {
            const unknown = {
                algos: ["rx/0", "cn-heavy/xhv"]
            };

            await addMiner("miner-unknown-a", unknown);
            await pool.waitForGetjobs(1);
            await addMiner("miner-unknown-b", unknown);
            await pool.waitForGetjobs(2);

            assert.equal(pool.logins.length, 1, "unknown miners with the same algo set should share one upstream");
            assertAlgoPayload(pool.getjobs[1].message, unknown.algos, {
                "rx/0": 1000,
                "cn-heavy/xhv": 10
            }, "unknown common getjob");
        });
    });

    test("a measured miner and an unknown miner use separate upstreams", async () => {
        await withProxy(async ({ addMiner, pool }) => {
            const measured = {
                algos: ["rx/0", "cn-heavy/xhv"],
                perfs: {
                    "rx/0": 1,
                    "cn-heavy/xhv": 1
                }
            };
            const unknown = {
                algos: ["rx/0", "cn-heavy/xhv"]
            };

            await addMiner("miner-measured", measured);
            await pool.waitForGetjobs(1);
            await addMiner("miner-unknown", unknown);
            await pool.waitForLogins(2);

            assert.equal(pool.logins.length, 2, "unknown performance data must not join a measured upstream");
            assertAlgoPayload(pool.logins[1].message, unknown.algos, {
                "rx/0": 1000,
                "cn-heavy/xhv": 10
            }, "unknown separate login");
        });
    });

    test("miner with a disjoint algo set opens a separate upstream", async () => {
        await withProxy(async ({ addMiner, pool }) => {
            await addMiner("miner-base", CAPABILITIES.base);
            await pool.waitForGetjobs(1);

            const disjoint = {
                algos: ["cn/half"],
                perfs: {
                    "cn/half": 2
                }
            };

            await addMiner("miner-disjoint", disjoint);
            await pool.waitForLogins(2);

            assertAlgoPayload(pool.logins[1].message, disjoint.algos, disjoint.perfs, "disjoint upstream login");
        });
    });

    test("removing a restrictive miner recomputes and widens the common algo set", async () => {
        await withProxy(async ({ addMiner, pool }) => {
            const minerA = await addMiner("miner-base", CAPABILITIES.base);
            await pool.waitForGetjobs(1);

            await addMiner("miner-superset", CAPABILITIES.superset);
            await pool.waitForGetjobs(2);
            assertAlgoPayload(pool.getjobs[1].message, CAPABILITIES.base.algos, {
                "rx/0": 2000,
                "cn-heavy/xhv": 20
            }, "common set before removal");

            minerA.close();
            await pool.waitForGetjobs(3);
            assertAlgoPayload(pool.getjobs[2].message, CAPABILITIES.superset.algos, CAPABILITIES.superset.perfs, "common set after removal");
        });
    });

    test("removing a miner does not resurrect performance measured outside the remaining common algos", async () => {
        await withProxy(async ({ addMiner, pool }) => {
            const first = await addMiner("miner-measured-rx", {
                algos: ["rx/0", "cn-heavy/xhv"],
                perfs: {
                    "rx/0": 800
                }
            });
            await pool.waitForGetjobs(1);

            await addMiner("miner-unknown-common", {
                algos: ["cn-heavy/xhv"]
            });
            await pool.waitForGetjobs(2);

            await addMiner("miner-measured-half", {
                algos: ["cn-heavy/xhv", "cn/half"],
                perfs: {
                    "cn/half": 1
                }
            });
            await pool.waitForGetjobs(3);

            first.close();
            await pool.waitForGetjobs(4);
            assertAlgoPayload(pool.getjobs[3].message, ["cn-heavy/xhv"], {
                "cn-heavy/xhv": 10
            }, "common getjob after measured miner removal");
        });
    });

    test("removing the last miner returns the upstream to default fallback capabilities", async () => {
        await withProxy(async ({ addMiner, pool }) => {
            const miner = await addMiner("miner-base", CAPABILITIES.base);
            await pool.waitForGetjobs(1);
            assertAlgoPayload(pool.getjobs[0].message, CAPABILITIES.base.algos, CAPABILITIES.base.perfs, "single miner getjob");

            miner.close();
            await pool.waitForGetjobs(2);
            assertAlgoPayload(pool.getjobs[1].message, DEFAULT_ALGOS, DEFAULT_PERFS, "empty upstream fallback getjob");
        });
    });

    test("zero algo-perf values group only with matching zero values", async () => {
        await withProxy(async ({ addMiner, pool }) => {
            const zero = {
                algos: ["rx/0", "cn-heavy/xhv"],
                perfs: {
                    "rx/0": 0,
                    "cn-heavy/xhv": 10
                }
            };

            await addMiner("miner-zero-a", zero);
            await pool.waitForGetjobs(1);
            await addMiner("miner-zero-b", zero);
            await pool.waitForGetjobs(2);

            assert.equal(pool.logins.length, 1, "matching zero perf miners should share one upstream");
            assertAlgoPayload(pool.getjobs[1].message, zero.algos, {
                "rx/0": 0,
                "cn-heavy/xhv": 20
            }, "matching zero perf common getjob");

            await addMiner("miner-nonzero", {
                algos: ["rx/0", "cn-heavy/xhv"],
                perfs: {
                    "rx/0": 1,
                    "cn-heavy/xhv": 10
                }
            });
            await pool.waitForLogins(2);
            assertAlgoPayload(pool.logins[1].message, ["rx/0", "cn-heavy/xhv"], {
                "rx/0": 1,
                "cn-heavy/xhv": 10
            }, "zero mismatch upstream login");
        });
    });
});
