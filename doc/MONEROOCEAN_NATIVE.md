# MoneroOcean native Stratum

The proxy routes the pool's existing object and native Stratum job formats. It
does not calculate proof of work. Pool-side share verification remains authoritative.

Existing MO XMRig clients retain their object-Stratum capability filtering and
NiceHash nonce splitting. They do not need a miner update or configuration change.

## Capabilities

An object login can opt into native family switching using the existing
`params.extensions` array:

```json
{"id":1,"method":"login","params":{"login":"wallet","pass":"x","algo":["rx/0","kawpow1","etchash"],"algo-perf":{"rx/0":1000,"kawpow1":1000000,"etchash":2000000},"extensions":["mo-native","submit-result"]}}
```

Only advertise algorithms the miner can actually execute. `ethash` and `etchash`
are distinct algorithms. `kawpow1` performance is in hashes per second; C29
performance is in cycles per second, as expected by the pool.

A fixed-algorithm miner may start with `mining.subscribe` and then
`mining.authorize`. This uses NiceHash mode and requires the proxy's `--algo`
setting so it can reserve an upstream nonce slot before authorization. Object
logins can subscribe afterward and switch between their advertised families.

`mo-native` means the client can switch between the advertised native families.
`submit-result` additionally promises a final hash on native submissions. The
login reply acknowledges supported extensions. These are capability fields, not
a new job or submission envelope.

Object submissions retain `params.result`. Native submission arrays retain their
original elements; a capable miner adds the final 32-byte hash as a top-level
`result` string only after negotiation. A mix hash, header hash, or C29 proof is
not a substitute for the final hash.

The final hash is 64 hexadecimal characters without `0x`. Generic CryptoNote
and C29 hashes use the existing little-endian integer convention. KawPow,
Ethash/Etchash, and Autolykos2 use their native big-endian final hash bytes.

## Difficulty and nonce ownership

Custom difficulty uses the existing NiceHash trust model. The proxy checks the
submitted hash against the job's assigned target and pool target. It acknowledges
qualifying lower-difficulty shares locally and forwards pool-difficulty shares.
It does not verify that a submitted hash was produced by the claimed nonce.

Native clients that do not report the final hash receive pool difficulty. Their
shares are forwarded to the pool, including when custom difficulty is configured.
This supports wrappers around hashless native miners without adding a verifier.

The 4-byte CryptoNote nonce path retains its existing slot layout. Partitionable
8-byte jobs use the real pool extranonce followed by a proxy slot byte. Profiles
that cannot safely partition nonce space use a dedicated upstream connection.
Job targets, nonce assignments, and submission formats belong to the issued job;
switching algorithms does not reinterpret a previous job's share.

## Validation

Run the offline fake-pool and fake-miner suites with `node run_tests.js`. Synthetic
hashes test protocol routing and difficulty decisions; they do not test PoW.

To additionally exercise an existing, unmodified MO XMRig binary:

```sh
XMRIG_PROXY_LEGACY_MINER=/absolute/path/to/xmrig node run_tests.js
```

That optional regression uses one CPU thread with OpenCL, CUDA, huge pages, and
MSR changes disabled. No GPU workload is needed for proxy validation.

The required MoM implementation changes are documented in the extensionless
`proxy` file at the root of the companion `mo-miner` checkout. That handoff does
not itself add missing miner backends.

The companion nodejs-pool removes miner-facing ethproxy/getWork methods. Its
daemon RPC work-fetching and block-submission methods remain in use. Multi-miner
may still translate a local child's legacy requests into native upstream Stratum.
