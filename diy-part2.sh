#!/bin/bash
#
# https://github.com/P3TERX/Actions-OpenWrt
# File name: diy-part2.sh
# Description: OpenWrt DIY script part 2 (After Update feeds)
#
# Copyright (c) 2019-2024 P3TERX <https://p3terx.com>
#
# This is free software, licensed under the MIT License.
# See /LICENSE for more information.
#
# ---------------------------------------------------------------------------
# 本项目改动：HiWiFi HC5761 换装 64MB SPI Flash 的分区适配
#
# 上游（ImmortalWrt openwrt-23.05）HC5761 的 16MB 布局：
#   u-boot    0x000000 0x030000  (192K)
#   hw_panic  0x030000 0x010000
#   factory   0x040000 0x010000  (art/EEPROM + MAC@0x4 + 5G eeprom@0x8000)
#   firmware  0x050000 0x0F7000  -> 到 0xFC0000 结束  (IMAGE_SIZE 15808k)
#   oem       0xFC0000 0x020000
#   bdinfo    0xFE0000 0x010000
#   backup    0xFF0000 0x010000
#
# 本脚本生成的 64MB 布局：
#   u-boot / hw_panic / factory 三段位置完全不动
#     —— Breed 的 u-boot(0x0) 与 art(0x40000) 备份位置必须保持不变，
#        动了就会刷完不认 art、没有 MAC、没有无线
#   firmware  0x050000 0x3FB0000 -> 到 0x4000000（整 64MB）结束
#   同时把 mt7620.mk 里 hiwifi_hc5761 的 IMAGE_SIZE 改成 65216k，
#   否则镜像大小校验还按 16MB 那套走。
#
# 注意：分区定义在共用文件 mt7620a_hiwifi_hc5x61.dtsi 里（hc5661/hc5761 共用），
#      所以这里复制一份新的 64M dtsi，只让 hc5761 引用它，不改上游原文件。
#
# ---------------------------------------------------------------------------
# 另外修一个 >16MB Flash 专属问题：软重启卡死（灯不亮、Breed 起不来，只能断电恢复）
#
# 原因链（kernel 5.15 drivers/mtd/spi-nor）：
#   1. flash 容量超过 16MB，内核走 4 字节地址模式。部分片子（如 W25Q256FV /
#      W25Q512 一类）没有 4B 指令码，spi_nor_init 会发 0xB7(EN4B) 让整片
#      进入 4 字节地址模式
#   2. 这个模式是易失状态，只有断电才复位；reboot 时 Breed 用 3 字节命令读，
#      直接读不到
#   3. 内核本来有退出函数 spi_nor_restore()（shutdown/remove 时调用），但条件是
#        addr_width==4 && !SNOR_F_4B_OPCODES && SNOR_F_BROKEN_RESET
#      SNOR_F_BROKEN_RESET 只来自 DTS 的 broken-flash-reset 属性 —— 上游 DTS 没写，
#      所以从不退出
#   4. Winbond 的退出实现还会补一步“清 EAR=0”：FV 版退出 4B 后扩展地址寄存器
#      残留 1，会让所有 3 字节读都落到后半片（这本身就是个起不来的坑）
#
# 所以补丁就是在 flash@0 节点里加一行 broken-flash-reset;，让 reboot 前自动发
# 0xE9 + 清 EAR。不改内核源码，零编译风险；开机 dmesg 会多一条 WARN（enabling
# reset hack），属正常提示。
# ---------------------------------------------------------------------------
set -euo pipefail

DTS_DIR=target/linux/ramips/dts
DEV_DTS=$DTS_DIR/mt7620a_hiwifi_hc5761.dts
SRC_DTSI=$DTS_DIR/mt7620a_hiwifi_hc5x61.dtsi
DST_DTSI=$DTS_DIR/mt7620a_hiwifi_hc5x61-64m.dtsi
IMAGE_MK=target/linux/ramips/image/mt7620.mk

echo "=== [1/5] 检查源码结构 ==="
for f in "$DEV_DTS" "$SRC_DTSI" "$IMAGE_MK"; do
    if [ ! -f "$f" ]; then
        echo "!! 缺少文件：$f"
        echo "!! 源码分支或目录结构和预期不一致，终止（避免白跑 3 小时）"
        exit 1
    fi
done

echo "=== [2/5] 复制分区定义并改成 64MB 布局 ==="
cp "$SRC_DTSI" "$DST_DTSI"

python3 - "$DST_DTSI" <<'PY'
import re
import sys
import pathlib

FLASH_SIZE = 0x4000000   # 64MB
FW_START = 0x50000       # 与上游 firmware 起始偏移保持一致
FW_SIZE = FLASH_SIZE - FW_START   # 0x3FB0000

path = pathlib.Path(sys.argv[1])
lines = path.read_text(encoding='utf-8').splitlines(keepends=True)

PART_RE = re.compile(r'^(\s*)(?:[A-Za-z0-9_]+:\s*)?partition@([0-9a-fA-F]+)\s*\{\s*$')
REG_RE = re.compile(r'\breg\s*=\s*<0x([0-9a-fA-F]+)\s+0x([0-9a-fA-F]+)>')


def parse(text_lines):
    blocks, i = [], 0
    while i < len(text_lines):
        m = PART_RE.match(text_lines[i])
        if not m:
            i += 1
            continue
        indent = m.group(1)
        addr = int(m.group(2), 16)
        j, label, off, size = i + 1, None, None, None
        while j < len(text_lines):
            if re.match(r'^%s\};' % re.escape(indent), text_lines[j]):
                break
            lm = re.search(r'label\s*=\s*"([^"]+)"', text_lines[j])
            if lm and label is None:
                label = lm.group(1)
            rm = REG_RE.search(text_lines[j])
            if rm and off is None:
                off, size = int(rm.group(1), 16), int(rm.group(2), 16)
            j += 1
        blocks.append({'addr': addr, 'label': label, 'off': off, 'size': size,
                       'start': i, 'end': j})
        i = j + 1
    return blocks


parts = parse(lines)
if not parts:
    sys.exit('!! dtsi 里解析不到 partition 节点，终止')

fw = [p for p in parts if p['label'] == 'firmware']
if len(fw) != 1:
    sys.exit('!! 找不到唯一的 firmware 分区（匹配到 %d 个），终止' % len(fw))

factory = [p for p in parts if p['label'] == 'factory']
if len(factory) != 1 or factory[0]['addr'] != 0x40000:
    sys.exit('!! factory(art) 分区不在 0x40000，Breed 的 art 位置会错位，终止')

# 1) 重写 firmware 的 reg 为 64MB 大小
hit = None
for k in range(fw[0]['start'], fw[0]['end'] + 1):
    m = REG_RE.search(lines[k])
    if m and hit is None:
        lines[k] = lines[k][:m.start()] + 'reg = <0x%x 0x%x>' % (FW_START, FW_SIZE) + lines[k][m.end():]
        hit = k
if hit is None:
    sys.exit('!! firmware 分区里没有 reg 属性，终止')

# 2) 删掉 16MB 布局末尾的 OEM 分区（扩容后会与 firmware 重叠，重叠分区直接起不来）
drop = [p for p in parts if p['label'] in ('oem', 'bdinfo', 'backup')]
if len(drop) != 3:
    print('    !! 预期 3 个 OEM 分区，实际匹配到 %d 个（继续执行，请留意日志）' % len(drop))
for p in sorted(drop, key=lambda b: b['start'], reverse=True):
    print('    删除 OEM 分区：%-8s 0x%08x (%dK)' % (p['label'], p['off'] or 0, (p['size'] or 0) // 1024))
    del lines[p['start']:p['end'] + 1]

# 3) 给 flash@0 节点加 broken-flash-reset
#    让内核在 shutdown/reboot 时走 spi_nor_restore()：发 0xE9 退出 4 字节地址模式 + 清 EAR。
#    没有这个属性，4B 模式的片子会一直停在 4B 模式，软重启后 Breed 读不到 flash。
joined = ''.join(lines)
if 'broken-flash-reset' in joined:
    print('    broken-flash-reset 已存在，跳过')
else:
    idx = None
    for k, ln in enumerate(lines):
        if re.search(r'flash@0\s*\{', ln):
            for j in range(k + 1, min(k + 8, len(lines))):
                if 'jedec,spi-nor' in lines[j]:
                    idx = j
                    break
            break
    if idx is None:
        sys.exit('!! 找不到 flash@0 / jedec,spi-nor 节点，无法加 broken-flash-reset，终止')
    indent = re.match(r'^(\s*)', lines[idx]).group(1)
    lines.insert(idx + 1, '%sbroken-flash-reset;\n' % indent)
    print('    已插入 broken-flash-reset;（修复软重启卡死）')

new_text = ''.join(lines)

# 4) 校验：不重叠 + 正好铺满 64MB + firmware 尺寸正确
new_parts = parse(new_text.splitlines(keepends=True))
print('    64MB 分区表：')
prev = 0
for p in sorted(new_parts, key=lambda b: b['off'] if b['off'] is not None else 1 << 40):
    if p['off'] is None or p['size'] is None:
        sys.exit('!! 分区 %s 缺少 reg 属性，终止' % p['label'])
    if p['off'] < prev:
        sys.exit('!! 分区 %s 与上一个分区重叠，终止' % p['label'])
    prev = p['off'] + p['size']
    print('      %-9s 0x%08x - 0x%08x  (%dK)' % (p['label'], p['off'], prev, p['size'] // 1024))

if prev != FLASH_SIZE:
    sys.exit('!! 分区表总长 0x%x，不是整 64MB（0x%x），终止' % (prev, FLASH_SIZE))

fw2 = [p for p in new_parts if p['label'] == 'firmware'][0]
if fw2['off'] != FW_START or fw2['size'] != FW_SIZE:
    sys.exit('!! firmware 分区不是 0x%x + 0x%x，终止' % (FW_START, FW_SIZE))

path.write_text(new_text, encoding='utf-8')
print('    64M 分区定义写入成功：%s' % path.name)
PY

echo "=== [3/5] 让 HC5761 引用 64M 分区定义 ==="
python3 - "$DEV_DTS" "$DST_DTSI" <<'PY'
import sys
import pathlib

dev = pathlib.Path(sys.argv[1])
new_name = pathlib.Path(sys.argv[2]).name
text = dev.read_text(encoding='utf-8')
old = '#include "mt7620a_hiwifi_hc5x61.dtsi"'
if old not in text:
    sys.exit('!! mt7620a_hiwifi_hc5761.dts 里没有原来的 dtsi 引用，上游结构变了，终止')
dev.write_text(text.replace(old, '#include "%s"' % new_name), encoding='utf-8')
print('    %s -> #include "%s"' % (old, new_name))
PY

echo "=== [4/5] 修改 mt7620.mk 的 IMAGE_SIZE ==="
python3 - "$IMAGE_MK" <<'PY'
import re
import sys
import pathlib

IMAGE_SIZE_K = 65216   # = 0x3FB0000 / 1024，与 64M firmware 分区大小严格一致

mk = pathlib.Path(sys.argv[1])
text = mk.read_text(encoding='utf-8')

m = re.search(r'define Device/hiwifi_hc5761\b[\s\S]*?\nendef', text)
if not m:
    sys.exit('!! mt7620.mk 里找不到 hiwifi_hc5761 设备定义，终止')

block = m.group(0)
old = re.search(r'IMAGE_SIZE\s*:=\s*[0-9]+[kKmM]', block)
if not old:
    sys.exit('!! hiwifi_hc5761 里没有 IMAGE_SIZE，终止')

new_block, n = re.subn(r'IMAGE_SIZE\s*:=\s*[0-9]+[kKmM]',
                       'IMAGE_SIZE := %dk' % IMAGE_SIZE_K, block)
if n != 1:
    sys.exit('!! IMAGE_SIZE 匹配到 %d 处（应只有 1 处），终止' % n)

mk.write_text(text[:m.start()] + new_block + text[m.end():], encoding='utf-8')
print('    IMAGE_SIZE: %s  ->  IMAGE_SIZE := %dk' % (old.group(0), IMAGE_SIZE_K))
PY

echo "=== [5/5] 回读校验（任何一项不对直接失败，不浪费编译时间）==="
DST_NAME=$(basename "$DST_DTSI")

grep -q 'broken-flash-reset;' "$DST_DTSI" \
    || { echo "!! 64M dtsi 里没有 broken-flash-reset（软重启会卡死）"; exit 1; }
grep -q 'reg = <0x50000 0x3fb0000>;' "$DST_DTSI" \
    || { echo "!! firmware 分区 reg 不是 0x50000 + 0x3fb0000"; exit 1; }
grep -q "#include \"$DST_NAME\"" "$DEV_DTS" \
    || { echo "!! hc5761.dts 没有引用 $DST_NAME"; exit 1; }
sed -n '/define Device\/hiwifi_hc5761/,/endef/p' "$IMAGE_MK" | grep -q 'IMAGE_SIZE := 65216k' \
    || { echo "!! mt7620.mk 里 hc5761 的 IMAGE_SIZE 不是 65216k"; exit 1; }

echo "=== 64M 补丁全部完成 ==="
echo "firmware 分区 = 0x50000 ~ 0x4000000，IMAGE_SIZE = 65216k，broken-flash-reset 已写入"
