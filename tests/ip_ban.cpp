/* Standalone tests for the proxy IP-ban cache. */

#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <string>

#include "proxy/IpBan.h"


namespace {


void check(bool condition, const char *expression, const char *file, int line)
{
    if (!condition) {
        std::fprintf(stderr, "%s:%d: check failed: %s\n", file, line, expression);
        std::abort();
    }
}


#define CHECK(expression) check((expression), #expression, __FILE__, __LINE__)


void testExpiryBoundary()
{
    xmrig::IpBan bans;
    constexpr uint64_t now = 1000;

    CHECK(bans.add("192.0.2.1", now));
    CHECK(bans.isBanned("192.0.2.1", now));
    CHECK(bans.isBanned("192.0.2.1", now + xmrig::IpBan::kDurationMs - 1));
    CHECK(!bans.isBanned("192.0.2.1", now + xmrig::IpBan::kDurationMs));
    CHECK(bans.size() == 0);
}


void testDuplicateDoesNotExtend()
{
    xmrig::IpBan bans;
    constexpr uint64_t now = 2000;

    CHECK(bans.add("192.0.2.2", now));
    CHECK(!bans.add("192.0.2.2", now + 5000));
    CHECK(bans.isBanned("192.0.2.2", now + xmrig::IpBan::kDurationMs - 1));
    CHECK(!bans.isBanned("192.0.2.2", now + xmrig::IpBan::kDurationMs));
}


void testExpiryPruneAndReadd()
{
    xmrig::IpBan bans;
    constexpr uint64_t first = 4000;

    CHECK(bans.add("192.0.2.3", first));
    CHECK(bans.add("192.0.2.4", first + 1));
    bans.prune(first + xmrig::IpBan::kDurationMs);
    CHECK(bans.size() == 1);
    CHECK(!bans.isBanned("192.0.2.3", first + xmrig::IpBan::kDurationMs));
    CHECK(bans.isBanned("192.0.2.4", first + xmrig::IpBan::kDurationMs));
    CHECK(bans.add("192.0.2.3", first + xmrig::IpBan::kDurationMs));
    CHECK(bans.size() == 2);
    CHECK(bans.isBanned("192.0.2.3", first + xmrig::IpBan::kDurationMs));
}


void testBoundedEviction()
{
    xmrig::IpBan bans;

    for (std::size_t i = 0; i < xmrig::IpBan::kCapacity; ++i) {
        CHECK(bans.add(("ip-" + std::to_string(i)).c_str(), 3000));
    }

    CHECK(bans.size() == xmrig::IpBan::kCapacity);
    CHECK(bans.isBanned("ip-0", 3001));
    CHECK(bans.add("ip-new", 3001));
    CHECK(bans.size() == xmrig::IpBan::kCapacity);
    CHECK(!bans.isBanned("ip-0", 3001));
    CHECK(bans.isBanned("ip-1", 3001));
    CHECK(bans.isBanned("ip-new", 3001));
    CHECK(bans.add("ip-0", 3002));
    CHECK(!bans.isBanned("ip-1", 3002));
    CHECK(bans.isBanned("ip-0", 3002));
}


void testRejectionMatching()
{
    CHECK(xmrig::IpBan::isLowDifficulty("Low difficulty share"));
    CHECK(xmrig::IpBan::isLowDifficulty("LOW DIFFICULTY SHARE"));
    CHECK(xmrig::IpBan::isLowDifficulty("lOw DiFfIcUlTy ShArE"));
    CHECK(!xmrig::IpBan::isLowDifficulty(""));
    CHECK(!xmrig::IpBan::isLowDifficulty("Low difficulty share "));
    CHECK(!xmrig::IpBan::isLowDifficulty("Low difficulty share\n"));
    CHECK(!xmrig::IpBan::isLowDifficulty("Low difficulty"));
    CHECK(!xmrig::IpBan::isLowDifficulty("Duplicate share"));
    CHECK(!xmrig::IpBan::isLowDifficulty(nullptr));
}


} // namespace


int main()
{
    testExpiryBoundary();
    testDuplicateDoesNotExtend();
    testExpiryPruneAndReadd();
    testBoundedEviction();
    testRejectionMatching();
    return 0;
}
