# Pool-triggered IP bans

The proxy bans a miner connection source IP for 24 hours when an upstream pool
rejects a forwarded share with the exact error `Low difficulty share`, compared
case-insensitively using ASCII. The first rejection starts the fixed monotonic
24-hour window; later matching rejections do not extend it. The ban uses the
connection's source IP, so all currently connected miners behind the same NAT
are closed and later connections from that IP are closed after registration.

The in-memory cache is cleared on restart and holds at most 65,536 live IPs.
When full, its oldest live entry is evicted. Expired entries are pruned in FIFO
order. Only upstream rejection creates a ban. Other pool errors remain excluded;
local share checks and local lower-difficulty acceptances do not create bans,
while forwarded shares remain covered when a miner uses custom difficulty. The
proxy does not add local hash validation.
