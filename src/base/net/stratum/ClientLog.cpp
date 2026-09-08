/* XMRig
 * Copyright (c) 2018-2021 SChernykh   <https://github.com/SChernykh>
 * Copyright (c) 2016-2021 XMRig       <https://github.com/xmrig>, <support@xmrig.com>
 *
 *   This program is free software: you can redistribute it and/or modify
 *   it under the terms of the GNU General Public License as published by
 *   the Free Software Foundation, either version 3 of the License, or
 *   (at your option) any later version.
 *
 *   This program is distributed in the hope that it will be useful,
 *   but WITHOUT ANY WARRANTY; without even the implied warranty of
 *   MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 *   GNU General Public License for more details.
 *
 *   You should have received a copy of the GNU General Public License
 *   along with this program. If not, see <http://www.gnu.org/licenses/>.
 */

#include <cinttypes>
#include <cstdio>
#include <cstring>


#include "base/net/stratum/Client.h"
#include "3rdparty/rapidjson/document.h"


namespace {

constexpr size_t kMaxLogText = 160;
constexpr size_t kMaxOfferedText = 512;


bool appendEscaped(std::string &out, const char *text, size_t maxSize)
{
    if (!text) {
        return true;
    }

    for (const auto *it = reinterpret_cast<const unsigned char *>(text); *it != '\0'; ++it) {
        char escaped[5] = {};
        const char *value = nullptr;

        switch (*it) {
        case '\\': value = "\\\\"; break;
        case '"':  value = "\\\""; break;
        case '\n': value = "\\n"; break;
        case '\r': value = "\\r"; break;
        case '\t': value = "\\t"; break;
        default:
            if (*it < 0x20 || *it == 0x7f) {
                std::snprintf(escaped, sizeof(escaped), "\\x%02x", *it);
                value = escaped;
            }
            break;
        }

        const size_t length = value ? std::strlen(value) : 1;
        if (out.size() + length > maxSize) {
            return false;
        }

        if (value) {
            out.append(value, length);
        }
        else {
            out.push_back(static_cast<char>(*it));
        }
    }

    return true;
}


} // namespace


const char *xmrig::Client::tag() const
{
    m_logTag = m_tag;
    m_logTag += " [upstream=";

    char id[32] = {};
    std::snprintf(id, sizeof(id), "%04" PRIuPTR, m_key);
    m_logTag += id;
    m_logTag += " algo=";
    m_logTag += (m_job.isValid() && m_job.algorithm().isValid() ? m_job.algorithm().name() : "none");
    m_logTag += " offered=";
    m_logTag += (m_logOffered.empty() ? "none" : m_logOffered);
    m_logTag += ']';

    return m_logTag.c_str();
}


const char *xmrig::Client::lastError() const
{
    return m_logCloseReason.c_str();
}


std::string xmrig::Client::logText(const char *text)
{
    std::string result;
    result.reserve(kMaxLogText);
    if (!appendEscaped(result, text && *text ? text : "unknown", kMaxLogText)) {
        if (result.size() + 3 > kMaxLogText) {
            result.resize(kMaxLogText - 3);
        }
        result += "...";
    }

    return result.empty() ? std::string("unknown") : result;
}


void xmrig::Client::captureLogOffered(const rapidjson::Value &params)
{
    m_logOffered.clear();

    if (!params.IsObject() || !params.HasMember("algo") || !params["algo"].IsArray()) {
        return;
    }

    for (const auto &algo : params["algo"].GetArray()) {
        if (!algo.IsString() || algo.GetStringLength() == 0) {
            continue;
        }

        std::string item;
        const bool complete = appendEscaped(item, algo.GetString(), kMaxOfferedText);
        if (!complete || m_logOffered.size() + item.size() + (m_logOffered.empty() ? 0 : 1) > kMaxOfferedText) {
            if (m_logOffered.size() + 3 > kMaxOfferedText) {
                m_logOffered.resize(kMaxOfferedText - 3);
            }
            m_logOffered += "...";
            break;
        }

        if (!m_logOffered.empty()) {
            m_logOffered.push_back(',');
        }
        m_logOffered += item;
    }
}


void xmrig::Client::setLogCloseReason(const char *reason)
{
    if (!m_logCloseReason.empty()) {
        return;
    }

    m_logCloseReason = logText(reason);
}


void xmrig::Client::clearLogCloseReason()
{
    m_logCloseReason.clear();
}
