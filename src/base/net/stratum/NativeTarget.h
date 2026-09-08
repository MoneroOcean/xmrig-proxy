/* XMRig
 * Portable 256-bit target parsing and comparison helpers.
 */

#ifndef XMRIG_NATIVE_TARGET_H
#define XMRIG_NATIVE_TARGET_H

#include <array>
#include <cstddef>
#include <cstdint>
#include <cstring>


namespace xmrig {


class NativeTarget final
{
public:
    using UInt256 = std::array<uint8_t, 32>;

    // Return the largest value representable by UInt256.
    static UInt256 max256()
    {
        UInt256 value = {};
        value.fill(0xff);
        return value;
    }

    // Parse exactly 64 hexadecimal digits, with an optional 0x prefix, into a
    // big-endian UInt256. No whitespace or other numeric prefixes are accepted.
    static bool strictHex64Parse(const char *text, UInt256 &out)
    {
        if (!text) {
            return false;
        }

        const char *value = text;
        if (value[0] == '0' && (value[1] == 'x' || value[1] == 'X')) {
            value += 2;
        }

        if (std::strlen(value) != 64) {
            return false;
        }

        UInt256 parsed = {};
        for (size_t i = 0; i < parsed.size(); ++i) {
            const int high = hexDigit(value[i * 2]);
            const int low = hexDigit(value[i * 2 + 1]);
            if (high < 0 || low < 0) {
                return false;
            }

            parsed[i] = static_cast<uint8_t>((high << 4) | low);
        }

        out = parsed;
        return true;
    }

    // Parse an unsigned decimal integer into a big-endian UInt256. Leading
    // zeroes are valid; signs, whitespace, and values above 2^256-1 are not.
    static bool strictDecimalParse(const char *text, UInt256 &out)
    {
        if (!text || !*text) {
            return false;
        }

        UInt256 parsed = {};
        for (const char *value = text; *value; ++value) {
            if (*value < '0' || *value > '9') {
                return false;
            }

            if (multiply10WithOverflow(parsed, static_cast<uint8_t>(*value - '0'))) {
                return false;
            }
        }

        out = parsed;
        return true;
    }

    // Lexicographically compare two big-endian UInt256 values.
    static int compareLex(const UInt256 &left, const UInt256 &right)
    {
        for (size_t i = 0; i < left.size(); ++i) {
            if (left[i] < right[i]) {
                return -1;
            }
            if (left[i] > right[i]) {
                return 1;
            }
        }

        return 0;
    }

    // Compute floor((2^256 - 1) / divisor) using bit-at-a-time long division.
    // A zero divisor is invalid and leaves out unchanged.
    static bool max256DividedBy(uint64_t divisor, UInt256 &out)
    {
        if (!divisor) {
            return false;
        }

        UInt256 quotient = {};
        uint64_t remainder = 0;

        for (size_t bit = 0; bit < 256; ++bit) {
            const bool carry = (remainder >> 63) != 0;
            remainder = (remainder << 1) | 1;
            if (carry || remainder >= divisor) {
                remainder -= divisor;
                quotient[bit / 8] |= static_cast<uint8_t>(0x80 >> (bit % 8));
            }
        }

        out = quotient;
        return true;
    }

    // Return true when value <= target, using the canonical big-endian form.
    static bool meets(const UInt256 &value, const UInt256 &target)
    {
        return compareLex(value, target) <= 0;
    }

    static void reverse(UInt256 &value)
    {
        for (size_t i = 0; i < value.size() / 2; ++i) {
            const size_t other = value.size() - 1 - i;
            const uint8_t byte = value[i];
            value[i] = value[other];
            value[other] = byte;
        }
    }

    // Render a UInt256 as 64 lowercase hexadecimal digits. The destination
    // must have room for 65 bytes including the terminating NUL.
    static bool toHex64(const UInt256 &value, char *out, size_t outSize)
    {
        static const char digits[] = "0123456789abcdef";
        if (!out || outSize < 65) {
            return false;
        }

        for (size_t i = 0; i < value.size(); ++i) {
            out[i * 2] = digits[value[i] >> 4];
            out[i * 2 + 1] = digits[value[i] & 0x0f];
        }
        out[64] = '\0';
        return true;
    }

private:
    static int hexDigit(char value)
    {
        if (value >= '0' && value <= '9') {
            return value - '0';
        }
        if (value >= 'a' && value <= 'f') {
            return value - 'a' + 10;
        }
        if (value >= 'A' && value <= 'F') {
            return value - 'A' + 10;
        }
        return -1;
    }

    static bool multiply10WithOverflow(UInt256 &value, uint8_t digit)
    {
        uint32_t carry = digit;
        for (size_t i = value.size(); i-- > 0;) {
            const uint32_t product = static_cast<uint32_t>(value[i]) * 10 + carry;
            value[i] = static_cast<uint8_t>(product);
            carry = product >> 8;
        }
        return carry != 0;
    }

};


} // namespace xmrig


#endif // XMRIG_NATIVE_TARGET_H
