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
# 本项目改动：helloworld（passwall 等插件所在源）默认不挂。
#   原因：你的目标只是「32M 分区能正常刷进去跑起来」，少挂一个第三方源
#         就少一个编译失败点（feeds 拉取失败是 Actions 编译最常见的事故）。
#   需要科学上网插件时：取消下面这行注释，并在 .config 里打开
#   CONFIG_PACKAGE_luci-app-passwall=y（或对应插件）。
# ---------------------------------------------------------------------------

# Uncomment a feed source
#sed -i 's/^#\(.*helloworld\)/\1/' feeds.conf.default

# Add a feed source
#echo 'src-git helloworld https://github.com/fw876/helloworld' >>feeds.conf.default
#echo 'src-git passwall https://github.com/xiaorouji/openwrt-passwall' >>feeds.conf.default
