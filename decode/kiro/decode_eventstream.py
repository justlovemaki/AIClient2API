#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
AWS event stream 解码器（用于 GenerateAssistantResponse 的流式响应）

用法：
  curl ... --output body.bin
  python3 decode_eventstream.py body.bin
  cat body.bin | python3 decode_eventstream.py

帧结构（AWS event stream, vnd.amazon.eventstream）：
  [4B total_len][4B headers_len][4B prelude_crc]
  [headers][payload][4B message_crc]
  header: [1B name_len][name][1B type][value]
     type 0=bool true,1=bool false,2=byte,3=short,4=int,5=long,
          6=byte[] ,7=string,8=timestamp,9=uuid
"""
import json
import struct
import sys


def _read_u32(b, i):
    return struct.unpack_from(">I", b, i)[0], i + 4


def parse_frames(buf):
    i = 0
    n = len(buf)
    while i + 12 <= n:
        total_len, headers_len, _prelude_crc = struct.unpack_from(">III", buf, i)
        if total_len <= 0 or i + total_len > n:
            break
        hstart = i + 12
        hend = hstart + headers_len
        headers = {}
        j = hstart
        while j < hend:
            nlen = buf[j]
            j += 1
            name = buf[j:j + nlen].decode()
            j += nlen
            htype = buf[j]
            j += 1
            if htype == 0:
                headers[name] = True
            elif htype == 1:
                headers[name] = False
            elif htype == 2:
                headers[name] = struct.unpack_from(">b", buf, j)[0]; j += 1
            elif htype == 3:
                headers[name] = struct.unpack_from(">h", buf, j)[0]; j += 2
            elif htype == 4:
                headers[name] = struct.unpack_from(">i", buf, j)[0]; j += 4
            elif htype == 5:
                headers[name] = struct.unpack_from(">q", buf, j)[0]; j += 8
            elif htype == 7:
                vlen = struct.unpack_from(">H", buf, j)[0]
                j += 2
                headers[name] = buf[j:j + vlen].decode("utf-8", "replace")
                j += vlen
            elif htype == 8:
                headers[name] = struct.unpack_from(">q", buf, j)[0]; j += 8
            elif htype == 9:
                headers[name] = buf[j:j + 16].hex(); j += 16
            else:
                break
        payload = buf[hend:i + total_len - 4]
        yield headers, payload
        i += total_len


def main(argv):
    if argv:
        buf = open(argv[0], "rb").read()
    else:
        buf = sys.stdin.buffer.read()
    count = 0
    for headers, payload in parse_frames(buf):
        count += 1
        etype = headers.get(":event-type") or headers.get(":exception-type") or "?"
        ctype = headers.get(":content-type", "")
        print(f"--- frame {count}  event-type={etype}  message-type={headers.get(':message-type')}  {ctype}")
        if ctype == "application/json" and payload:
            try:
                print(json.dumps(json.loads(payload), indent=2, ensure_ascii=False)[:2000])
                continue
            except Exception:
                pass
        if payload:
            print(payload[:600].decode("utf-8", "replace"))
    print(f"total frames: {count}")


if __name__ == "__main__":
    main(sys.argv[1:])
