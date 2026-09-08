/* XMRig
 * Copyright (c) 2016-2026 xmrig.com
 */

#ifndef XMRIG_GETJOB_COOLDOWN_H
#define XMRIG_GETJOB_COOLDOWN_H


#include <cstddef>
#include <cstdint>
#include <map>
#include <string>


namespace xmrig {


class GetjobCooldown
{
public:
    constexpr static uint64_t kDuration = 10 * 60 * 1000;

    bool allows(uint64_t now, const std::string &algos) const
    {
        return m_rejectedAt == 0 || m_rejectedAlgos != algos || now - m_rejectedAt >= kDuration;
    }

    inline void reject(uint64_t now, const std::string &algos)
    {
        m_rejectedAt = now;
        m_rejectedAlgos = algos;
    }

    inline void clear()
    {
        m_rejectedAt = 0;
        m_rejectedAlgos.clear();
    }

private:
    std::string m_rejectedAlgos;
    uint64_t m_rejectedAt = 0;
};


class CapabilityErrorLog
{
public:
    constexpr static uint64_t kDuration = GetjobCooldown::kDuration;
    constexpr static std::size_t kMaxEntries = 64;

    bool allows(uint64_t now, const std::string &key)
    {
        auto it = m_entries.find(key);
        if (it != m_entries.end()) {
            if (now >= it->second && now - it->second < kDuration) {
                return false;
            }

            it->second = now;
            return true;
        }

        if (m_entries.size() >= kMaxEntries) {
            auto oldest = m_entries.begin();
            auto candidate = oldest;
            ++candidate;
            for (; candidate != m_entries.end(); ++candidate) {
                if (candidate->second < oldest->second) {
                    oldest = candidate;
                }
            }

            m_entries.erase(oldest);
        }

        m_entries.emplace(key, now);
        return true;
    }

    inline std::size_t size() const
    {
        return m_entries.size();
    }

private:
    std::map<std::string, uint64_t> m_entries;
};


} /* namespace xmrig */


#endif /* XMRIG_GETJOB_COOLDOWN_H */
