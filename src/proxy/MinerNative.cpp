/* MoneroOcean native Stratum adapters. Shares use the existing NiceHash trust model. */
#include "proxy/Miner.h"
#include "base/io/json/Json.h"
#include "base/net/stratum/NativeTarget.h"
#include "base/tools/Cvt.h"
#include "proxy/Error.h"
#include "proxy/events/AcceptEvent.h"
#include "proxy/events/SubmitEvent.h"
#include "proxy/events/SubscribeEvent.h"
#include "3rdparty/rapidjson/document.h"
#include "3rdparty/rapidjson/stringbuffer.h"
#include "3rdparty/rapidjson/writer.h"
#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstring>
#include <limits>
#include <string>

using namespace rapidjson;
namespace xmrig {
namespace {
String serialized(const Value &value) {
    StringBuffer buffer;
    Writer<StringBuffer> writer(buffer);
    value.Accept(writer);
    return String(buffer.GetString(), buffer.GetSize());
}
bool arrayJob(const Job &job) {
    const auto algo = job.algorithm();
    return algo == Algorithm::KAWPOW_RVN || algo == Algorithm::ETHASH || algo == Algorithm::ETCHASH || algo == Algorithm::AUTOLYKOS2;
}
std::string hexNonce(const char *value) {
    if (!value) return {};
    if (value[0] == '0' && (value[1] == 'x' || value[1] == 'X')) value += 2;
    std::string out(value);
    std::transform(out.begin(), out.end(), out.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return out;
}
String targetHex(uint64_t diff) {
    NativeTarget::UInt256 target{};
    NativeTarget::max256DividedBy(diff, target);
    char hex[65];
    NativeTarget::toHex64(target, hex, sizeof(hex));
    return String(hex, 64);
}
bool multiplyTarget(const NativeTarget::UInt256 &target, uint32_t factor, NativeTarget::UInt256 &scaled) {
    uint64_t carry = 0;
    for (size_t i = target.size(); i-- > 0;) {
        const uint64_t product = static_cast<uint64_t>(target[i]) * factor + carry;
        scaled[i] = static_cast<uint8_t>(product);
        carry = product >> 8;
    }
    return carry == 0;
}
bool jackpotMeets(const NativeTarget::UInt256 &jackpot, const NativeTarget::UInt256 &target, uint32_t factor, bool saturateOverflow) {
    NativeTarget::UInt256 scaled{};
    if (!multiplyTarget(target, factor, scaled)) return saturateOverflow;
    return NativeTarget::meets(jackpot, scaled);
}
String targetDecimal(uint64_t diff) {
    NativeTarget::UInt256 value{};
    NativeTarget::max256DividedBy(diff, value);
    std::string digits;
    while (std::any_of(value.begin(), value.end(), [](uint8_t b) { return b != 0; })) {
        unsigned remainder = 0;
        for (auto &byte : value) {
            const unsigned n = remainder * 256 + byte;
            byte = static_cast<uint8_t>(n / 10);
            remainder = n % 10;
        }
        digits.push_back(static_cast<char>('0' + remainder));
    }
    std::reverse(digits.begin(), digits.end());
    return digits.empty() ? String("0") : String(digits.c_str());
}
}

bool Miner::dispatchRequest(const Value &message) {
    const Value &wireId = Json::getValue(message, "id");
    const char *method = Json::getString(message, "method");
    if (!method || !(wireId.IsString() || wireId.IsInt64()) || m_requestIds.size() >= 1024) return false;
    const int64_t id = --m_requestSequence;
    // Plain C29 JSON clients expect boolean submit replies, unlike XMRig's status object.
    const bool booleanReply = std::strncmp(method, "mining.", 7) == 0 ||
        (std::strcmp(method, "submit") == 0 && hasExtension(EXT_BOOL_SUBMIT));
    m_requestIds.emplace(id, std::make_pair(serialized(wireId), booleanReply));
    const auto &params = Json::getValue(message, "params");
    return parseNativeRequest(id, method, params, message) || parseRequest(id, method, params);
}

void Miner::addReplyId(Document &doc, int64_t id) {
    auto found = m_requestIds.find(id);
    if (found == m_requestIds.end()) { doc.AddMember("id", id, doc.GetAllocator()); return; }
    Document wireId;
    wireId.Parse(found->second.first.data(), found->second.first.size());
    doc.AddMember("id", Value().CopyFrom(wireId, doc.GetAllocator()), doc.GetAllocator());
    m_requestIds.erase(found);
}
void Miner::replyResult(int64_t id, const Value &result, const char *error) {
    Document doc(kObjectType);
    auto &a = doc.GetAllocator();
    addReplyId(doc, id);
    doc.AddMember("jsonrpc", "2.0", a);
    if (error) {
        Value problem(kObjectType);
        problem.AddMember("code", -1, a);
        problem.AddMember("message", Value(error, a), a);
        doc.AddMember("error", problem, a);
    }
    else {
        doc.AddMember("error", kNullType, a);
        doc.AddMember("result", Value().CopyFrom(result, a), a);
    }
    send(doc);
}
void Miner::replyWithError(int64_t id, const char *message) { replyResult(id, Value(), message); }
void Miner::success(int64_t id, const char *status) {
    const auto found = m_requestIds.find(id);
    if (found != m_requestIds.end() && found->second.second) { replyResult(id, Value(true)); return; }
    Document result(kObjectType);
    result.AddMember("status", Value(status, result.GetAllocator()), result.GetAllocator());
    replyResult(id, result);
}
void Miner::setNativeAlgorithm(const Algorithm &algorithm) {
    m_algos = { algorithm };
    m_algoPerfs.clear();
    m_algoPerfs[algorithm.id()] = 1.0F;
}
void Miner::rememberJob(const Job &job) {
    if (m_job.clientId() != job.clientId()) m_prevJob.reset();
    else if (m_job.isValid() && m_job.id() != job.id()) m_prevJob = m_job;
    m_job = job;
    m_diff = job.diff();
}
uint64_t Miner::assignedDiff(const Job &job) const {
    if ((job.algorithm() == Algorithm::PEARLHASH && !hasExtension(EXT_PEARL_SEED_SPLIT)) ||
        ((arrayJob(job) || job.algorithm() == Algorithm::C29) && !hasExtension(EXT_SUBMIT_RESULT))) return job.diff();
    if (m_customDiff) return std::min(m_customDiff, job.diff());

    const auto algorithm = job.algorithm();
    const bool autoLocalDiff =
        (algorithm == Algorithm::PEARLHASH && hasExtension(EXT_PEARL_SEED_SPLIT)) ||
        (hasExtension(EXT_SUBMIT_RESULT) &&
         (algorithm == Algorithm::KAWPOW_RVN || algorithm == Algorithm::ETHASH ||
          algorithm == Algorithm::ETCHASH || algorithm == Algorithm::AUTOLYKOS2 ||
          algorithm == Algorithm::C29));
    const auto measured = m_algoPerfs.find(algorithm.id());
    if (!autoLocalDiff || measured == m_algoPerfs.end() ||
        !std::isfinite(measured->second) || measured->second <= 0.0F) return job.diff();

    // Aim for one local result about every 15 seconds. Never make a pool job more than 256 times
    // easier: that is the number of disjoint nonce slots available to one aggregated upstream.
    constexpr long double interval = 15.0L;
    constexpr uint64_t slots = 256;
    const long double desired = std::ceil(static_cast<long double>(measured->second) * interval);
    const uint64_t measuredDiff = desired >= std::numeric_limits<uint64_t>::max()
        ? std::numeric_limits<uint64_t>::max()
        : std::max<uint64_t>(1, static_cast<uint64_t>(desired));
    const uint64_t slotFloor = job.diff() / slots + (job.diff() % slots != 0);
    return std::min(job.diff(), std::max(measuredDiff, slotFloor));
}
String Miner::assignedPrefix(const Job &job) const {
    std::string prefix;
    if (!job.nativePrefix().isEmpty()) prefix.assign(job.nativePrefix().data());
    if (hasExtension(EXT_NICEHASH) && job.algorithm() == Algorithm::C29 &&
        hasExtension(EXT_SUBMIT_RESULT) && job.nonceSize() == 8) {
        char slot[3];
        snprintf(slot, sizeof(slot), "%02x", m_fixedByte);
        prefix += slot;
    }
    else if (hasExtension(EXT_NICEHASH) && job.algorithm() != Algorithm::C29) {
        if (prefix.empty()) return {};
        char slot[3];
        snprintf(slot, sizeof(slot), "%02x", m_fixedByte);
        prefix += slot;
    }
    if (prefix.empty()) return {};
    return prefix.c_str();
}
void Miner::sendSubscription() {
    if (!m_subscribeId || mapperId() < 0) return;
    const String prefix = assignedPrefix(m_job);
    if (prefix.isEmpty() || prefix.size() >= 16) return;
    Document result(kArrayType);
    auto &a = result.GetAllocator();
    Value subscriptions(kArrayType);
    subscriptions.PushBack("mining.notify", a);
    subscriptions.PushBack(m_rpcId.toJSON(), a);
    subscriptions.PushBack("EthereumStratum/1.0.0", a);
    result.PushBack(subscriptions, a);
    result.PushBack(prefix.toJSON(), a);
    // EthereumStratum derives the remaining nonce width from the prefix.
    if (!m_nativeProtocol || (m_job.algorithm() != Algorithm::ETHASH && m_job.algorithm() != Algorithm::ETCHASH)) {
        result.PushBack(static_cast<unsigned>(8 - prefix.size() / 2), a);
    }
    replyResult(m_subscribeId, result);
    m_subscribeId = 0;
}

bool Miner::parseNativeRequest(int64_t id, const char *method, const Value &params, const Value &message) {
    if (strcmp(method, "eth_submitHashrate") == 0) {
        if (m_state != ReadyState || !hasExtension(EXT_NATIVE)) {
            replyWithError(id, Error::toString(Error::Unauthenticated));
        }
        else if (!params.IsArray() || params.Size() != 2 || !params[0].IsString() || !params[1].IsString()) {
            replyWithError(id, Error::toString(Error::InvalidMethod));
        }
        else {
            // Optional miner telemetry: acknowledge it, but never trust it for share accounting.
            heartbeat();
            replyResult(id, Value(true));
        }
        return true;
    }
    if (strcmp(method, "mining.subscribe") == 0) {
        if (!params.IsArray() || params.Empty() || !params[0].IsString() || m_subscribeId) {
            replyWithError(id, Error::toString(Error::InvalidMethod)); return true;
        }
        m_nativeProtocol = m_state == WaitLoginState;
        setExtension(EXT_NATIVE, true);
        m_agent = params[0].GetString();
        m_subscribeId = id;
        if (mapperId() < 0) {
            SubscribeEvent::create(this)->start();
            if (mapperId() < 0) {
                replyWithError(id, "Native subscribe requires NiceHash mode and a configured --algo");
                m_subscribeId = 0;
                return true;
            }
        }
        sendSubscription();
        return true;
    }
    if (strcmp(method, "mining.extranonce.subscribe") == 0 && hasExtension(EXT_NATIVE)) { success(id, "OK"); return true; }
    if (strcmp(method, "mining.authorize") == 0) {
        if (!m_nativeProtocol && params.IsObject()) {
            const char *wallet = Json::getString(params, "wallet");
            const char *worker = Json::getString(params, "worker");
            const char *agent = Json::getString(params, "agent");
            const char *type = Json::getString(params, "type");
            const char *pass = Json::getString(params, "pass");
            if (wallet && *wallet && worker && agent && type && !pass) {
                m_nativeProtocol = true;
                m_agent = agent;
                setExtension(EXT_NATIVE, true);
                setNativeAlgorithm(Algorithm(Algorithm::PEARLHASH));
            }
        }
        if (!m_nativeProtocol || m_state != WaitLoginState) {
            replyWithError(id, Error::toString(Error::Unauthenticated)); return true;
        }
        const char *user = nullptr;
        const char *pass = nullptr;
        std::string objectUser;
        if (params.IsArray() && params.Size() >= 2 && params[0].IsString() && params[1].IsString()) {
            user = params[0].GetString();
            pass = params[1].GetString();
        }
        else if (params.IsObject()) {
            const char *wallet = Json::getString(params, "wallet");
            const char *worker = Json::getString(params, "worker");
            pass = Json::getString(params, "pass");
            if (wallet && worker) {
                if (!pass) pass = "x";
                objectUser = wallet;
                if (*worker) objectUser += std::string(".") + worker;
                user = objectUser.c_str();
            }
        }
        if (!user || !pass) {
            replyWithError(id, Error::toString(Error::Unauthenticated)); return true;
        }
        Document login(kObjectType);
        auto &a = login.GetAllocator();
        login.AddMember("login", Value(user, a), a);
        login.AddMember("pass", Value(pass, a), a);
        login.AddMember("agent", m_agent.toJSON(login), a);
        Value algos(kArrayType), extensions(kArrayType);
        for (const auto &algo : m_algos) algos.PushBack(algo.toJSON(), a);
        extensions.PushBack("mo-native", a);
        login.AddMember("algo", algos, a);
        login.AddMember("extensions", extensions, a);
        parseRequest(id, "login", login);
        if (m_state == WaitReadyState) {
            setState(ReadyState);
            success(id, "OK");
        }
        return true;
    }
    if (strcmp(method, "mining.submit") == 0) {
        if (m_state != ReadyState || !hasExtension(EXT_NATIVE)) { replyWithError(id, Error::toString(Error::Unauthenticated)); return true; }
        heartbeat();
        return submitJob(id, params, &message);
    }
    return false;
}

void Miner::sendNative(const Job &job) {
    if (!job.hasNativePayload()) return;
    Document wire;
    if (wire.Parse(job.nativePayload().data(), job.nativePayload().size()).HasParseError()) return;
    auto &a = wire.GetAllocator();
    Value &params = wire["params"];
    const bool nativeArray = params.IsArray();
    if (!nativeArray && params.IsObject() && params.HasMember("id")) {
        params["id"].SetString(m_rpcId.data(), static_cast<SizeType>(m_rpcId.size()), a);
    }
    const uint64_t diff = assignedDiff(job);
    const String prefix = assignedPrefix(job);
    if (nativeArray && prefix.isEmpty()) return;
    if (diff < job.diff()) {
        if (job.algorithm() == Algorithm::KAWPOW_RVN) params[3].SetString(targetHex(diff).data(), a);
        else if (job.algorithm() == Algorithm::AUTOLYKOS2) params[6].SetString(targetDecimal(diff).data(), a);
        else if (!nativeArray && params.HasMember("difficulty")) params["difficulty"].SetUint64(diff);
        else if (!nativeArray && job.algorithm() == Algorithm::PEARLHASH &&
                 hasExtension(EXT_PEARL_SEED_SPLIT) && params.HasMember("target") &&
                 params["target"].IsString() && params["target"].GetStringLength() == 64) {
            const String target = targetHex(diff);
            params["target"].SetString(target.data(), a);
        }
        else if (!nativeArray && params.HasMember("target")) {
            const size_t bytes = strlen(params["target"].GetString()) / 2;
            uint64_t t = UINT64_MAX / diff;
            uint8_t le[8];
            for (size_t i = 0; i < 8; ++i) le[i] = static_cast<uint8_t>(t >> (i * 8));
            const String target = Cvt::toHex(le + (bytes == 4 ? 4 : 0), bytes == 4 ? 4 : 8);
            params["target"].SetString(target.data(), a);
        }
    }
    if (!nativeArray && job.algorithm() == Algorithm::C29 && hasExtension(EXT_SUBMIT_RESULT) &&
        job.nonceSize() == 4 && params.IsObject()) {
        const uint32_t nonce = static_cast<uint32_t>(m_fixedByte) << 24;
        if (params.HasMember("nonce")) params["nonce"].SetUint(nonce);
        else params.AddMember("nonce", nonce, a);
        if (params.HasMember("nicehash_mask")) params["nicehash_mask"].SetUint(0xff000000U);
        else params.AddMember("nicehash_mask", 0xff000000U, a);
    }
    if (!nativeArray && job.algorithm() == Algorithm::PEARLHASH && hasExtension(EXT_PEARL_SEED_SPLIT) && params.IsObject()) {
        if (params.HasMember("nonce_slot")) params["nonce_slot"].SetUint(m_fixedByte);
        else params.AddMember("nonce_slot", m_fixedByte, a);
        if (params.HasMember("nonce_stride")) params["nonce_stride"].SetUint(256);
        else params.AddMember("nonce_stride", 256, a);
    }
    if (!nativeArray && job.algorithm() == Algorithm::C29 && hasExtension(EXT_SUBMIT_RESULT) &&
        job.nonceSize() == 8 && !prefix.isEmpty() && params.IsObject()) {
        if (params.HasMember("xn")) params["xn"].SetString(prefix.data(), a);
        else params.AddMember("xn", prefix.toJSON(), a);
    }
    else if (!nativeArray && job.nonceSize() == 8 && !prefix.isEmpty() && params.HasMember("xn")) {
        params["xn"].SetString(prefix.data(), a);
    }
    if (!nativeArray && job.nonceSize() == 4 && job.algorithm() != Algorithm::C29 && hasExtension(EXT_NICEHASH) && params.HasMember("blob")) {
        std::string blob(params["blob"].GetString());
        char slot[3]; snprintf(slot, sizeof(slot), "%02x", m_fixedByte);
        blob.replace((job.nonceOffset() + 3) * 2, 2, slot);
        params["blob"].SetString(blob.c_str(), a);
    }
    if (m_state == WaitReadyState) {
        setState(ReadyState);
        if (m_nativeProtocol) success(m_loginId, "OK");
        else {
            Document result(kObjectType);
            auto &r = result.GetAllocator();
            result.AddMember("id", m_rpcId.toJSON(), r);
            result.AddMember("algo", job.algorithm().toJSON(), r);
            result.AddMember("status", "OK", r);
            if (!prefix.isEmpty()) result.AddMember("extra_nonce", prefix.toJSON(), r);
            Value extensions(kArrayType);
            extensions.PushBack("algo", r); extensions.PushBack("mo-native", r); extensions.PushBack("keepalive", r);
            if (hasExtension(EXT_NICEHASH)) extensions.PushBack("nicehash", r);
            if (hasExtension(EXT_SUBMIT_RESULT)) extensions.PushBack("submit-result", r);
            if (hasExtension(EXT_PEARL_SEED_SPLIT)) extensions.PushBack("pearl-seed-split", r);
            result.AddMember("extensions", extensions, r);
            if (!nativeArray) result.AddMember("job", Value().CopyFrom(params, r), r);
            replyResult(m_loginId, result);
            if (!nativeArray) return;
        }
    }
    if (m_state != ReadyState) return;
    if (nativeArray) {
        Document extra(kObjectType);
        auto &e = extra.GetAllocator();
        extra.AddMember("method", "mining.set_extranonce", e);
        extra.AddMember("algo", job.algorithm().toJSON(), e);
        Value values(kArrayType);
        values.PushBack(prefix.toJSON(), e);
        // Standard Ethereum/KawPow Stratum uses only the prefix; preserve MO's width hint.
        if (!m_nativeProtocol || (job.algorithm() != Algorithm::KAWPOW_RVN &&
            job.algorithm() != Algorithm::ETHASH && job.algorithm() != Algorithm::ETCHASH)) {
            values.PushBack(static_cast<unsigned>(8 - prefix.size() / 2), e);
        }
        extra.AddMember("params", values, e);
        send(extra);
    }
    if (!job.nativeControl().isEmpty()) {
        Document control;
        if (!control.Parse(job.nativeControl().data(), job.nativeControl().size()).HasParseError()) {
            if (diff < job.diff()) {
                if (job.algorithm() == Algorithm::KAWPOW_RVN) control["params"][0].SetString(targetHex(diff).data(), control.GetAllocator());
                else if (job.algorithm() == Algorithm::ETHASH || job.algorithm() == Algorithm::ETCHASH) control["params"][0].SetDouble(static_cast<double>(diff) / 4294967296.0);
            }
            send(control);
        }
    }
    send(wire);
}

bool Miner::submitJob(int64_t id, const Value &params, const Value *native) {
    auto reject = [&](Error::Code code) {
        if (m_state == ReadyState && code != Error::Unauthenticated) {
            auto *event = SubmitEvent::create(this, id, nullptr, nullptr, nullptr, Algorithm(), nullptr, nullptr, nullptr, 0, -1);
            event->setError(code);
            event->start();
        }
        replyWithError(id, Error::toString(code));
        return true;
    };
    const bool nativeProtocol = native != nullptr;
    const bool nativeArray = nativeProtocol && params.IsArray();
    if (m_state != ReadyState) return reject(Error::Unauthenticated);
    if (nativeArray ? (params.Size() < 3 || !params[1].IsString() || !params[2].IsString()) : !params.IsObject()) return reject(Error::LowDifficulty);
    const char *jobId = nativeArray ? params[1].GetString() : Json::getString(params, "job_id");
    if (!jobId) return reject(Error::InvalidJobId);
    const Job *job = m_job.isValid() && m_job.id() == jobId ? &m_job : (m_prevJob.isValid() && m_prevJob.id() == jobId ? &m_prevJob : nullptr);
    if (!job) return reject(Error::InvalidJobId);
    const bool pearl = !nativeArray && job->algorithm() == Algorithm::PEARLHASH;
    if (nativeProtocol && !nativeArray && !pearl) return reject(Error::IncorrectAlgorithm);
    if (!nativeArray && !pearl && m_rpcId != Json::getString(params, "id")) return reject(Error::Unauthenticated);
    if (nativeArray != arrayJob(*job)) return reject(Error::IncorrectAlgorithm);
    const Algorithm claimed(nativeArray ? nullptr : Json::getString(params, "algo"));
    if (claimed.isValid() && claimed != job->algorithm()) return reject(Error::IncorrectAlgorithm);
    const char *hash = nativeArray ? Json::getString(*native, "result") : Json::getString(params, "result");
    const bool hashRequired = !pearl && ((!nativeArray && job->algorithm() != Algorithm::C29) || hasExtension(EXT_SUBMIT_RESULT));
    NativeTarget::UInt256 hashBytes{};
    if ((hashRequired || hash) && (!hash || strlen(hash) != 64 || !NativeTarget::strictHex64Parse(hash, hashBytes))) return reject(Error::LowDifficulty);
    NativeTarget::UInt256 pearlJackpot{};
    uint32_t pearlFactor = 0;
    if (pearl) {
        const char *proof = Json::getString(params, "plain_proof");
        const char *jackpot = Json::getString(params, "jackpot");
        const auto &factor = Json::getValue(params, "adjustment_factor");
        const bool hasJackpot = jackpot != nullptr;
        const bool hasFactor = !factor.IsNull();
        if (!proof || !*proof || hasJackpot != hasFactor) return reject(Error::LowDifficulty);
        if (hasJackpot) {
            if (strlen(jackpot) != 64 || !factor.IsUint() || factor.GetUint() == 0) return reject(Error::LowDifficulty);
            for (const char *p = jackpot; *p; ++p) {
                if (!((*p >= '0' && *p <= '9') || (*p >= 'a' && *p <= 'f'))) return reject(Error::LowDifficulty);
            }
            if (!NativeTarget::strictHex64Parse(jackpot, pearlJackpot)) return reject(Error::LowDifficulty);
            NativeTarget::reverse(pearlJackpot);
            pearlFactor = factor.GetUint();
        }
        if (hasExtension(EXT_PEARL_SEED_SPLIT) && (!hasJackpot || !hasFactor)) {
            return reject(Error::LowDifficulty);
        }
    }
    std::string nonce;
    if (!nativeArray && params.HasMember("nonce") && params["nonce"].IsUint() && job->algorithm() == Algorithm::C29 && job->nonceSize() == 4) {
        char n[9]; snprintf(n, sizeof(n), "%08x", params["nonce"].GetUint()); nonce = n;
    }
    else if (!pearl) nonce = hexNonce(nativeArray ? params[2].GetString() : Json::getString(params, "nonce"));
    const String prefix = assignedPrefix(*job);
    const size_t width = job->nonceSize();
    if (!pearl && width == 8 && !prefix.isEmpty() && nonce.size() == 16 - prefix.size()) nonce = std::string(prefix.data()) + nonce;
    uint8_t nonceBytes[8];
    if (!pearl) {
        if (width > 8 || nonce.size() != width * 2 || !Cvt::fromHex(nonceBytes, width, nonce.c_str(), nonce.size())) return reject(Error::InvalidNonce);
        if (width == 8 && (prefix.isEmpty() || nonce.compare(0, prefix.size(), hexNonce(prefix.data())) != 0)) return reject(Error::InvalidNonce);
        if (width == 4 && job->algorithm() == Algorithm::C29 && hasExtension(EXT_SUBMIT_RESULT) && nonceBytes[0] != m_fixedByte) return reject(Error::InvalidNonce);
        if (width == 4 && job->algorithm() != Algorithm::C29 && hasExtension(EXT_NICEHASH) && nonceBytes[3] != m_fixedByte) return reject(Error::InvalidNonce);
    }
    if (job->algorithm() == Algorithm::C29) {
        Document payload; payload.Parse(job->nativePayload().data(), job->nativePayload().size());
        const unsigned size = Json::getUint(payload["params"], "proofsize");
        const auto &proof = Json::getValue(params, "pow");
        if (!proof.IsArray() || proof.Size() != size) return reject(Error::LowDifficulty);
        uint32_t last = 0;
        for (SizeType i = 0; i < proof.Size(); ++i) { if (!proof[i].IsUint() || (i && proof[i].GetUint() <= last)) return reject(Error::LowDifficulty); last = proof[i].GetUint(); }
    }
    if (nativeArray && job->algorithm() == Algorithm::KAWPOW_RVN) {
        NativeTarget::UInt256 value{};
        if (params.Size() < 5 || !params[3].IsString() || !params[4].IsString() || !NativeTarget::strictHex64Parse(params[3].GetString(), value) || !NativeTarget::strictHex64Parse(params[4].GetString(), value)) return reject(Error::LowDifficulty);
    }
    const uint64_t minerDiff = assignedDiff(*job);
    if (hashRequired && !job->nativeHashMeetsDifficulty(hash, minerDiff)) return reject(Error::LowDifficulty);
    bool poolShare = !hashRequired || (job->nativeTarget().isEmpty() ? job->nativeHashMeetsDifficulty(hash, job->diff()) : job->nativeHashMeetsTarget(hash));
    if (pearl && hasExtension(EXT_PEARL_SEED_SPLIT)) {
        NativeTarget::UInt256 localTarget{};
        NativeTarget::UInt256 upstreamTarget{};
        if (!NativeTarget::max256DividedBy(minerDiff, localTarget) || job->nativeTarget().isEmpty() ||
            !NativeTarget::strictHex64Parse(job->nativeTarget().data(), upstreamTarget) ||
            !jackpotMeets(pearlJackpot, localTarget, pearlFactor, true)) {
            return reject(Error::LowDifficulty);
        }
        if (!jackpotMeets(pearlJackpot, upstreamTarget, pearlFactor, false)) {
            success(id, "OK");
            SubmitResult accepted(1, job->diff(), 0, id, 0);
            accepted.assignedDiff = minerDiff;
            AcceptEvent::start(m_mapperId, this, accepted, false, true);
            return true;
        }
    }
    uint64_t actualDiff = 0;
    if (hash) {
        if (!arrayJob(*job)) NativeTarget::reverse(hashBytes);
        uint64_t high = 0; for (size_t i = 0; i < 8; ++i) high = (high << 8) | hashBytes[i];
        actualDiff = high ? UINT64_MAX / high : UINT64_MAX;
    }
    if (!poolShare) {
        success(id, "OK");
        SubmitResult accepted(1, job->diff(), actualDiff, id, 0);
        accepted.assignedDiff = minerDiff;
        AcceptEvent::start(m_mapperId, this, accepted, false, true);
        return true;
    }
    auto *event = SubmitEvent::create(this, id, jobId, pearl ? "" : nonce.c_str(), hash, job->algorithm(), Json::getString(params, "sig"), m_signatureData, Json::getString(params, "commitment"), m_viewTag, m_extraNonce);
    event->request.assignedDiff = minerDiff;
    event->request.setActualDiff(actualDiff);
    if (nativeArray || job->algorithm() == Algorithm::C29 || pearl) {
        Document wire(kObjectType);
        if (native) wire.CopyFrom(*native, wire.GetAllocator());
        else { wire.AddMember("method", "submit", wire.GetAllocator()); wire.AddMember("params", Value().CopyFrom(params, wire.GetAllocator()), wire.GetAllocator()); }
        if (nativeArray && hexNonce(params[2].GetString()).size() != 16) wire["params"][2].SetString(nonce.c_str(), wire.GetAllocator());
        event->request.nativePayload = serialized(wire);
        event->request.nativeArray = nativeArray;
    }
    Error::Code error = Error::NoError;
    if (!event->start(&error)) replyWithError(id, Error::toString(error));
    return error != Error::InvalidNonce;
}
}
