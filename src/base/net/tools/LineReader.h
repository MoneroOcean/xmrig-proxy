/* XMRig
 * Copyright (c) 2020      cohcho      <https://github.com/cohcho>
 * Copyright (c) 2018-2020 SChernykh   <https://github.com/SChernykh>
 * Copyright (c) 2016-2020 XMRig       <https://github.com/xmrig>, <support@xmrig.com>
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

#ifndef XMRIG_LINEREADER_H
#define XMRIG_LINEREADER_H


#include "base/kernel/constants.h"
#include "base/tools/Object.h"


#include <cstddef>
#include <vector>


namespace xmrig {


class ILineListener;


class LineReader
{
public:
    XMRIG_DISABLE_COPY_MOVE(LineReader)

    LineReader() = default;
    LineReader(ILineListener *listener) : m_listener(listener) {}

    inline void setListener(ILineListener *listener) { m_listener = listener; }
    inline void setMaxSize(size_t size) { if (size > m_maxSize) m_maxSize = size; }

    void parse(char *data, size_t size);
    void reset();

private:
    void add(const char *data, size_t size);
    void getline(char *data, size_t size);

    std::vector<char> m_buf;
    ILineListener *m_listener   = nullptr;
    size_t m_maxSize            = XMRIG_NET_BUFFER_CHUNK_SIZE;
    bool m_discard              = false;
};


} /* namespace xmrig */


#endif /* XMRIG_NETBUFFER_H */
