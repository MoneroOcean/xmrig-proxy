// SPDX-License-Identifier: GPL-3.0-or-later


#include <cstring>


#include "base/io/log/Log.h"
#include "base/io/log/Tags.h"
#include "base/tools/Chrono.h"
#include "proxy/events/AcceptEvent.h"
#include "proxy/Miner.h"
#include "proxy/Miners.h"


void xmrig::Miners::onRejectedEvent(IEvent *event)
{
    if (!event || event->type() != IEvent::AcceptType) {
        return;
    }

    const auto *accept = static_cast<const AcceptEvent *>(event);
    const char *error = accept->error();
    const String &minerIp = accept->result.minerIp;
    if (accept->isCustomDiff() || !error || minerIp.isEmpty() ||
        !IpBan::isLowDifficulty(error)) {
        return;
    }

    const uint64_t now = Chrono::steadyMSecs();
    if (!m_ipBan.add(minerIp.data(), now)) {
        return;
    }

    LOG_WARN("%s banned IP \"%s\" for 24h after low difficulty share", Tags::proxy(), minerIp.data());

    for (const auto &entry : m_miners) {
        Miner *miner = entry.second;
        if (miner && std::strcmp(miner->ip(), minerIp.data()) == 0) {
            miner->close();
        }
    }
}
