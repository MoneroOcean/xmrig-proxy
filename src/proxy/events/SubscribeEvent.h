/* XMRig
 * Native miner subscription event.
 */

#ifndef XMRIG_SUBSCRIBEEVENT_H
#define XMRIG_SUBSCRIBEEVENT_H


#include "proxy/events/MinerEvent.h"


namespace xmrig {


class SubscribeEvent : public MinerEvent
{
public:
    static inline SubscribeEvent *create(Miner *miner)
    {
        return new (m_buf) SubscribeEvent(miner);
    }

    inline bool isRejected() const override { return m_rejected; }

protected:
    inline explicit SubscribeEvent(Miner *miner) : MinerEvent(SubscribeType, miner) {}
};


} /* namespace xmrig */


#endif /* XMRIG_SUBSCRIBEEVENT_H */
