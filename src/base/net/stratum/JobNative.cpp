/* XMRig
 * Native job target and payload helpers.
 */

#include <cstdint>

#include "base/net/stratum/Job.h"
#include "base/net/stratum/NativeTarget.h"
#include "3rdparty/rapidjson/document.h"
#include "3rdparty/rapidjson/stringbuffer.h"
#include "3rdparty/rapidjson/writer.h"

#ifdef XMRIG_PROXY_PROJECT


namespace {


xmrig::String serializeJSON(const rapidjson::Value &value)
{
    rapidjson::StringBuffer buffer;
    rapidjson::Writer<rapidjson::StringBuffer> writer(buffer);
    value.Accept(writer);

    return xmrig::String(buffer.GetString(), buffer.GetSize());
}


bool hashIsBigEndian(const xmrig::Job &job)
{
    return job.nativeTargetBigEndian() || job.algorithm() == xmrig::Algorithm::KAWPOW_RVN ||
           job.algorithm() == xmrig::Algorithm::ETHASH || job.algorithm() == xmrig::Algorithm::ETCHASH ||
           job.algorithm() == xmrig::Algorithm::AUTOLYKOS2;
}


} // namespace


bool xmrig::Job::setNativePayload(const rapidjson::Value &message)
{
    if (!message.IsObject() || !message.HasMember("method")) {
        return false;
    }

    m_nativePayload = serializeJSON(message);
    return !m_nativePayload.isNull();
}


void xmrig::Job::setNativePrefix(const char *prefix)
{
    m_nativePrefix = (prefix && *prefix) ? prefix : nullptr;
}


bool xmrig::Job::setNativeTarget(const char *target, bool bigEndian)
{
    if (!target) {
        return false;
    }

    xmrig::NativeTarget::UInt256 bytes = {};
    if (!xmrig::NativeTarget::strictHex64Parse(target, bytes)) {
        return false;
    }

    if (!bigEndian) {
        xmrig::NativeTarget::reverse(bytes);
    }

    char canonical[65] = {};
    if (!xmrig::NativeTarget::toHex64(bytes, canonical, sizeof(canonical))) {
        return false;
    }

    m_nativeTarget = String(canonical, 64);
    m_nativeTargetBigEndian = bigEndian;
    return true;
}


bool xmrig::Job::nativeHashMeetsDifficulty(const char *hash, uint64_t difficulty) const
{
    if (!difficulty) {
        return false;
    }

    xmrig::NativeTarget::UInt256 hashBytes = {};
    if (!xmrig::NativeTarget::strictHex64Parse(hash, hashBytes)) {
        return false;
    }

    xmrig::NativeTarget::UInt256 targetBytes = {};
    if (!xmrig::NativeTarget::max256DividedBy(difficulty, targetBytes)) {
        return false;
    }

    // The generated MAX256/difficulty target is always canonical BE. Reverse
    // only the submitted hash when the wire hash is little-endian.
    if (!hashIsBigEndian(*this)) {
        xmrig::NativeTarget::reverse(hashBytes);
    }

    return xmrig::NativeTarget::meets(hashBytes, targetBytes);
}


bool xmrig::Job::nativeHashMeetsTarget(const char *hash) const
{
    if (m_nativeTarget.isNull()) {
        return false;
    }

    xmrig::NativeTarget::UInt256 hashBytes = {};
    xmrig::NativeTarget::UInt256 targetBytes = {};
    if (!xmrig::NativeTarget::strictHex64Parse(hash, hashBytes) ||
        !xmrig::NativeTarget::strictHex64Parse(m_nativeTarget.data(), targetBytes)) {
        return false;
    }

    // setNativeTarget stores a canonical BE target, so the wire hash is the
    // only value that needs reversing for little-endian native formats.
    if (!hashIsBigEndian(*this)) {
        xmrig::NativeTarget::reverse(hashBytes);
    }

    return xmrig::NativeTarget::meets(hashBytes, targetBytes);
}


#endif
