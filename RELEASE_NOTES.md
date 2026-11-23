# 版本更新说明

> 每次发版前更新本文件，内容会自动写入对应 Release 的发布说明；不改则沿用上一版内容。

## 本次新增插件

### 诊断工具
- **watchcat**：断线看门狗，ping 网关/公网连续失败后自动重连或重启路由
- **nlbwmon**：按设备统计上下行流量与排行
- **commands**：菜单内一键执行自定义命令
- **tcpdump-mini**：命令行抓包（带 libpcap）
- **iperf3**：内网带宽测速
- **mtr-nojson**：路由跟踪与丢包统计
- **haveged**：熵池增强，加快无线与加密握手
- **diskman**：U 盘挂载、分区、格式化网页管理（已关闭用不到的 btrfs-progs 与 mdadm）

### 网络服务
- **WireGuard**：内核态异地组网（luci-proto-wireguard + kmod-wireguard）
- **vsftpd**：FTP 文件共享
- **eqos**：按 IP 上下行限速
- **travelmate**：上游无线断线后自动切换中继
- **USB 打印机**：p910nd + kmod-usb-printer，USB 打印机网络共享

## 首页功能（自建 LuCI，Argon 蓝白卡片风格）
- 五卡一行：Flash 存储 / 设备信息 / 网络+网口堆叠 / 无线网络，下方为局域网设备表
- Flash、内存双环形图环外引线标注分段名与容量
- 网络卡：LAN / WAN / 网关 / DNS；网口：1 WAN + 2 LAN 瓦片，区分在用/空闲
- 无线卡：2.4G / 5G 信道、SSID、BSSID、加密方式、关联数，可跳转无线设置

## 已有服务与环境
- 代理：Passwall 精简版（SS / SSR-libev + Simple-Obfs + Trojan-Plus，关闭 Xray / SingBox / Geodata 等大内核）
- 基础服务：UPnP、WOL 网络唤醒、VLMCSD、XLNetacc、ttyd 网页终端
- 机型：极路由2 HiWiFi HC5761 · MT7620A · 128MB 内存 · 32MB SPI Flash（W25Q256）
- 源码：ImmortalWrt 23.05 · 内核 5.15；主题 Argon（iStoreOS 同款蓝白），Material 备用

## 刷写提醒
- Breed 刷 sysupgrade；分区：u-boot 0x0 / hw_panic 0x30000 / factory(art) 0x40000 / firmware 0x50000-0x2000000
- 换了页面看不到变化，先开无痕窗口排除浏览器缓存
- 刷机有风险，操作自担
