# 版本更新说明

> 每次发版前更新本文件，内容会自动写入对应 Release 的发布说明；不改则沿用上一版内容。

## 首页（自建 LuCI 首页，Argon 蓝白卡片风格）
- 五卡一行：Flash 存储 / 设备信息 / 网络+网口堆叠 / 无线网络，下方为局域网设备表
- Flash、内存双环形图环外引线标注分段名与容量；网络卡显示 LAN / WAN / 网关 / DNS；网口 1 WAN + 2 LAN 瓦片
- 无线网络卡：2.4G / 5G 信道、SSID、BSSID、加密方式、关联数，可跳转无线设置

## 内置插件
- 诊断工具：watchcat 断线看门狗、nlbwmon 流量统计、commands 自定义命令、tcpdump-mini、iperf3、mtr-nojson、haveged、diskman 磁盘管理
- 网络服务：WireGuard、vsftpd、eqos 限速、travelmate 中继、USB 打印机共享
- 代理：Passwall 精简版（SS / SSR-libev + Simple-Obfs + Trojan-Plus，关闭 Xray / SingBox / Geodata 等大内核）
- 基础服务：UPnP、WOL 网络唤醒、VLMCSD、XLNetacc、ttyd 网页终端

## 硬件与环境
- 机型：极路由2 HiWiFi HC5761 · MT7620A · 128MB 内存 · 32MB SPI Flash（W25Q256）
- 源码：ImmortalWrt 23.05 · 内核 5.15
- 主题：Argon（iStoreOS 同款蓝白），Material 备用
