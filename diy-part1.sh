#!/bin/bash
#
# https://github.com/P3TERX/Actions-OpenWrt
# File name: diy-part1.sh
# Description: OpenWrt DIY script part 1 (Before Update feeds)
#
# Copyright (c) 2019-2024 P3TERX <https://p3terx.com>
#
# This is free software, licensed under the MIT License.
# See /LICENSE for more information.
#
# ---------------------------------------------------------------------------
# Passwall 第三方源：passwall_packages（内核/辅助程序）+ passwall_luci（面板），
# 两个都要挂，缺一个 luci-app-passwall 就装不上。
# 体积控制：.config 里只保留 SS/SSR-libev 客户端 + Simple-Obfs + Trojan-Plus，
#           Xray / Sing-Box / Hysteria / NaiveProxy / Geodata 等大内核显式关闭。
# ---------------------------------------------------------------------------

# Uncomment a feed source
#sed -i 's/^#\(.*helloworld\)/\1/' feeds.conf.default

# Add Passwall feed source
echo 'src-git passwall_packages https://github.com/Openwrt-Passwall/openwrt-passwall-packages.git;main' >>feeds.conf.default
echo 'src-git passwall_luci https://github.com/Openwrt-Passwall/openwrt-passwall.git;main' >>feeds.conf.default
