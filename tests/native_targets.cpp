/* XMRig
 * Standalone tests for the portable native target helper.
 */

#include <cstddef>
#include <cstdio>
#include <cstdlib>
#include <cstring>

#include "base/net/stratum/NativeTarget.h"


namespace {


using Target = xmrig::NativeTarget;
using UInt256 = Target::UInt256;


void check(bool condition, const char *expression, const char *file, int line)
{
    if (!condition) {
        std::fprintf(stderr, "%s:%d: check failed: %s\n", file, line, expression);
        std::abort();
    }
}


#define CHECK(expression) check((expression), #expression, __FILE__, __LINE__)


UInt256 parseHex(const char *text)
{
    UInt256 value = {};
    CHECK(Target::strictHex64Parse(text, value));
    return value;
}


const char *hex(const UInt256 &value)
{
    static char output[65];
    CHECK(Target::toHex64(value, output, sizeof(output)));
    return output;
}


void testParsing()
{
    UInt256 value = {};
    CHECK(Target::strictHex64Parse("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff", value));
    CHECK(std::strcmp(hex(value), "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff") == 0);
    CHECK(Target::strictHex64Parse("ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef0123456789", value));
    CHECK(!Target::strictHex64Parse("", value));
    CHECK(!Target::strictHex64Parse("0x", value));
    CHECK(!Target::strictHex64Parse("0x1", value));
    CHECK(!Target::strictHex64Parse("0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffg", value));
    CHECK(!Target::strictHex64Parse(" ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff", value));

    CHECK(Target::strictDecimalParse("0", value));
    CHECK(std::strcmp(hex(value), "0000000000000000000000000000000000000000000000000000000000000000") == 0);
    CHECK(Target::strictDecimalParse("000000000000000000000000000000000000000000000000000000000000000000001", value));
    CHECK(std::strcmp(hex(value), "0000000000000000000000000000000000000000000000000000000000000001") == 0);
    CHECK(Target::strictDecimalParse(
        "115792089237316195423570985008687907853269984665640564039457584007913129639935", value));
    CHECK(std::strcmp(hex(value), "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff") == 0);
    CHECK(!Target::strictDecimalParse("", value));
    CHECK(!Target::strictDecimalParse("+1", value));
    CHECK(!Target::strictDecimalParse("-1", value));
    CHECK(!Target::strictDecimalParse("1.0", value));
    CHECK(!Target::strictDecimalParse(
        "115792089237316195423570985008687907853269984665640564039457584007913129639936", value));
}


void testDivision()
{
    CHECK(std::strcmp(hex(Target::max256()), "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff") == 0);

    UInt256 quotient = {};
    CHECK(Target::max256DividedBy(1, quotient));
    CHECK(std::strcmp(hex(quotient), "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff") == 0);
    CHECK(Target::max256DividedBy(1000, quotient));
    CHECK(std::strcmp(hex(quotient), "004189374bc6a7ef9db22d0e5604189374bc6a7ef9db22d0e5604189374bc6a7") == 0);
    CHECK(Target::max256DividedBy(0xffffffffffffffffULL, quotient));
    CHECK(std::strcmp(hex(quotient), "0000000000000001000000000000000100000000000000010000000000000001") == 0);

    quotient = parseHex("1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef");
    CHECK(!Target::max256DividedBy(0, quotient));
    CHECK(std::strcmp(hex(quotient), "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef") == 0);
}


void testComparisonAndEndian()
{
    const UInt256 zero = parseHex("0000000000000000000000000000000000000000000000000000000000000000");
    const UInt256 one = parseHex("0000000000000000000000000000000000000000000000000000000000000001");
    const UInt256 max = parseHex("ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
    CHECK(Target::compareLex(zero, zero) == 0);
    CHECK(Target::compareLex(zero, one) < 0);
    CHECK(Target::compareLex(one, zero) > 0);
    CHECK(Target::compareLex(max, max) == 0);
    CHECK(Target::meets(zero, max));
    CHECK(Target::meets(max, max));
    CHECK(!Target::meets(max, zero));

    UInt256 reversed = parseHex("0123456789abcdeffedcba9876543210112233445566778899aabbccddeeff00");
    Target::reverse(reversed);
    CHECK(std::strcmp(hex(reversed), "00ffeeddccbbaa9988776655443322111032547698badcfeefcdab8967452301") == 0);
    Target::reverse(reversed);
    CHECK(std::strcmp(hex(reversed), "0123456789abcdeffedcba9876543210112233445566778899aabbccddeeff00") == 0);
}


} // namespace


int main()
{
    testParsing();
    testDivision();
    testComparisonAndEndian();
    return 0;
}
