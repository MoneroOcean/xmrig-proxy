// SPDX-License-Identifier: GPL-3.0-or-later

#ifndef XMRIG_IPBAN_H
#define XMRIG_IPBAN_H


#include <cstdint>
#include <cstddef>
#include <deque>
#include <string>
#include <unordered_set>


namespace xmrig {


class IpBan
{
public:
    static constexpr uint64_t kDurationMs = 24ULL * 60ULL * 60ULL * 1000ULL;
    static constexpr size_t kCapacity = 65536;

    static inline bool isLowDifficulty(const char *error)
    {
        static const char expected[] = "Low difficulty share";
        if (!error) {
            return false;
        }

        for (size_t i = 0;; ++i) {
            if (!expected[i] || !error[i]) {
                return expected[i] == error[i];
            }

            const char left = expected[i] >= 'A' && expected[i] <= 'Z' ? static_cast<char>(expected[i] + ('a' - 'A')) : expected[i];
            const char right = error[i] >= 'A' && error[i] <= 'Z' ? static_cast<char>(error[i] + ('a' - 'A')) : error[i];
            if (left != right) {
                return false;
            }
        }
    }

    inline bool add(const char *ip, uint64_t now)
    {
        if (!ip || !*ip) {
            return false;
        }

        prune(now);
        const auto result = m_entries.emplace(ip);
        if (!result.second) {
            return false;
        }

        m_fifo.emplace_back(ip, now + kDurationMs);
        if (m_entries.size() > kCapacity) {
            m_entries.erase(m_fifo.front().first);
            m_fifo.pop_front();
        }

        return true;
    }

    inline bool isBanned(const char *ip, uint64_t now)
    {
        if (!ip || !*ip) {
            return false;
        }

        prune(now);
        return m_entries.find(ip) != m_entries.end();
    }

    inline void prune(uint64_t now)
    {
        while (!m_fifo.empty()) {
            if (m_fifo.front().second > now) {
                break;
            }

            m_entries.erase(m_fifo.front().first);
            m_fifo.pop_front();
        }
    }

    inline size_t size() const
    {
        return m_entries.size();
    }

private:
    std::unordered_set<std::string> m_entries;
    std::deque<std::pair<std::string, uint64_t>> m_fifo;
};


} /* namespace xmrig */


#endif /* XMRIG_IPBAN_H */
