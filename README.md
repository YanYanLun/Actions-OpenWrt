# HC5761 换 32MB Flash —— ImmortalWrt 自编译（GitHub Actions）

HiWiFi HC5761（极路由 2）SPI Flash 由 16MB 硬改为 32MB 后，用 GitHub Actions 自编译 ImmortalWrt 23.05 的完整流程：分区补丁、编译触发、Breed 刷写、验收命令、软重启修复、LuCI 主题与插件，全部已验证。

**结论先行**：本仓库的 Actions 直接 Run 一次即可产出可刷的 `sysupgrade.bin`（同尺寸 32M → 32M 可直接网页升级，跨尺寸必须进 Breed）。

## 目录

一、改了什么 ｜ 二、分区表 ｜ 三、触发编译 ｜ 四、Breed 刷写 ｜ 五、刷完验收 ｜ 六、后续怎么改 ｜ 七、扩容还要动什么（32MB/64MB） ｜ 八、LuCI 换皮 Argon ｜ 九、软重启卡死修复 ｜ 十、服务插件与主题 ｜ 十一、Flash 信息页 ｜ 十二、图形化仪表盘 ｜ 十三、来源与致谢

---

## 一、改了什么（对照上游）

| 文件 | 改动 |
| --- | --- |
| `.github/workflows/openwrt-builder.yml` | 源码从 `coolsnowwolf/lede` 换成 `immortalwrt/immortalwrt` + `openwrt-23.05`；加 ccache 缓存、加"32M 补丁自检"步骤、加超时保护 |
| `diy-part2.sh` | 新增 32M 分区补丁（生成 32M dtsi、改写 HC5761 的 include、改 `mt7620.mk` 的 `IMAGE_SIZE`），改完自带校验，出错直接终止编译 |
| `.config` | 从空占位换成最小骨架（目标设备 + LuCI 中文 + 常用工具 + USB 存储）+ 主题 Argon/Material + 4 个基础服务插件（wol/upnp/vlmcsd/xlnetacc）+ Passwall 科学上网面板，其余由 `make defconfig` 补全 |
| `files/etc/uci-defaults/99-luci-theme` | 开机把默认主题设成 Argon（iStoreOS 同款），没有则退回 material / bootstrap |
| `files/etc/uci-defaults/99-argon-look` | 开机把 Argon 主色设为 `#2f7ef7`、登录页背景设为纯色（不拉 Bing 图） |
| `files/www/luci-static/argon/css/global.css` + Argon `header.htm` | 全局覆盖样式：把状态 / 系统 / 网络等 stock 页面的卡片、表格、表单、按钮、标签页对齐首页蓝白卡片风格 |
| `files/www/luci-static/resources/view/flashinfo.js` 等 3 个文件 | 自建「状态 → Flash 信息」页：直接显示 32MB 总容量与 mtd 分区表 |
| `files/www/luci-static/resources/view/dash.js` 等 3 个文件 | 自建「状态 → 仪表盘」页：CPU/内存/网速实时曲线、内存环形图、Flash 堆叠条，零依赖零安装 |
| `diy-part1.sh` | 挂载 Passwall 第三方源（passwall_packages 内核 + passwall_luci 面板） |
| `.gitattributes` | 强制 `.sh` / `.yml` / `.config` 用 LF，避免 Windows 下 CRLF 让 bash 报 `bad interpreter` |

---

## 二、分区表（本次改动核心）

上游 16MB：

| 分区 | 偏移 | 大小 |
| --- | --- | --- |
| u-boot | 0x000000 | 0x030000 (192K) |
| hw_panic | 0x030000 | 0x010000 (64K) |
| factory（art/EEPROM + MAC + 5G cal） | 0x040000 | 0x010000 (64K) |
| firmware | 0x050000 | 0x0F7000 → 到 0xFC0000 |
| oem / bdinfo / backup | 0xFC0000 起 | 共 0x040000 |

本仓库改成 32MB：

| 分区 | 偏移 | 大小 |
| --- | --- | --- |
| u-boot | 0x000000 | 0x030000 (192K) |
| hw_panic | 0x030000 | 0x010000 (64K) |
| factory（art/EEPROM + MAC + 5G cal） | 0x040000 | 0x010000 (64K) |
| **firmware** | **0x050000** | **0x1FB0000（32448K）→ 到 0x2000000（整 32MB）** |

配套 `IMAGE_SIZE := 32448k`（原来 15808k）。

**为什么前三个分区一格都不动：** Breed 烧固件固定在 0x050000，art（EEPROM）固定在 0x040000。
这两个位置动了，就会刷完没 MAC、没无线、甚至不进系统。
所以只把 firmware 的尾巴拉长到 32MB 末尾，并删掉 16M 尾部那三个 OEM 分区（不删的话会和扩容后的 firmware 重叠，重叠分区直接起不来）。

> 上游分区定义在共用文件 `mt7620a_hiwifi_hc5x61.dtsi`（hc5661/hc5761 共用）。
> 脚本是**复制一份**成 `mt7620a_hiwifi_hc5x61-32m.dtsi` 再改，只让 hc5761 引用它，不动上游原文件。

---

## 三、触发编译

1. 提交并推送到你自己仓库的 `hc5761-openwrt-23.05` 分支
2. 仓库 → **Actions** → 左侧 **OpenWrt Builder** → **Run workflow** → 选该分支 → Run
3. 前 ~3 分钟的 `Verify 32M patch` 日志就是自检，必须看到：

```
IMAGE_SIZE := 32448k
      u-boot    0x00000000 - 0x00030000  (192K)
      hw_panic  0x00030000 - 0x00040000  (64K)
      factory   0x00040000 - 0x00050000  (64K)
      firmware  0x00050000 - 0x02000000  (32448K)
```

4. 首次约 3～4 小时。成功后在 **Artifacts** 下载 `OpenWrt_firmware_hiwifi_hc5761_*`，
   或到 **Releases** 下（保留最近 3 个）。
   目标文件：`immortalwrt-ramips-mt7620-hiwifi_hc5761-squashfs-sysupgrade.bin`

> **注意：HC5761 没有 factory.bin。** 上游 `Device/hiwifi_hc5761` 只定义 `sysupgrade.bin`
> （没有 `IMAGES += factory.bin`），所以 release 资产里只有
> `-squashfs-sysupgrade.bin`、`-initramfs-kernel.bin`、`-rootfs.tar.gz`。
> 别去找 factory，Breed 直接刷 **sysupgrade.bin** 就对了：
> 这个文件是 uImage(64 + 内核) + squashfs 的**裸拼接**，不是 tar 也不是压缩包，
> Breed 会原样写到 0x50000。

> 首次编译后 ccache 已缓存，下次改配置重编一般 40 分钟左右，省 Actions 额度（每月 2000 分钟）。

---

## 四、刷写（Breed，严格顺序）

1. 进 Breed（拔电 → 按住 reset 上电，或原厂系统里进）
2. **先恢复 art**：备份/恢复 → 恢复 EEPROM(art) → 选你**本机备份**的 art.bin（只勾 EEPROM）
3. **删环境变量**：Breed 里之前设过的 `bootargs` / `mtdparts` 全部删掉（现在由 DTS 接管分区，留着会冲突）
4. 固件更新 → 选 `...-squashfs-sysupgrade.bin` → 只勾"固件" → 刷入
   （HC5761 没有 factory.bin，Breed 刷 sysupgrade.bin 就是标准做法；Breed 只按字节写到 0x50000）
5. 等 1～2 分钟自动重启，进 `192.168.1.1`

**跨尺寸（16M 固件 ↔ 32M 固件）不能走 sysupgrade / LuCI 升级**（分区表大小校验对不上），必须 Breed 刷；
刷完是全新系统，**旧配置不保留**（overlay 在 firmware 分区里，被整段覆盖）。

**同尺寸（32M → 32M）之后**，LuCI 里的固件升级 / `sysupgrade -n` 都正常。

---

## 五、刷完必须做的 3 项验证

```sh
# 1) 分区是否真的 32M（firmware 应该是 01fb0000）
cat /proc/mtd

# 期望：
# mtd0: 00030000 00010000 "u-boot"
# mtd1: 00010000 00010000 "hw_panic"
# mtd2: 00010000 00010000 "factory"
# mtd3: 01fb0000 00010000 "firmware"

# 2) SPI 芯片是否被正确识别成 32MB（单位字节，应为 33554432）
dmesg | grep -iE 'spi-nor|m25p|w25q|mx25|jedec'

# 3) 无线 + MAC 是否正常（factory 分区读到了）
dmesg | grep -iE 'ieee80211|mt76'
ip link show | grep -E 'wlan|eth'
```

### 硬件层面的一个已知限制（不是补丁写错）

MT7620A 的 SPI 在 **3 字节地址模式**下最多只能寻址 **16MB**；要用满 32MB，必须走 **4 字节地址模式**，
且 flash 芯片本身要支持 4B（如 W25Q256 / MX25L25635 这类）。
Linux 的 spi-nor 对 >16MB 的芯片通常会自动切 4B opcode，但个别芯片/驱动组合会失败。

如果上面第 1 步只看到 `firmware` 是 `00f70000`（约 16M），或者第 2 步识别的容量是 16777216，
说明 4B 模式没生效——那是 SoC/芯片层面的问题，再改分区表也没用，需要针对性打 SPI 驱动的补丁。

---

## 六、后续怎么改

- **加插件**：编辑 `.config`，加 `CONFIG_PACKAGE_xxx=y` 后重新 Run workflow。
  不确定包名时，本地拉源码 `make menuconfig` 调好，把生成的 `.config` 覆盖过来即可。
- **Passwall**：已在 `diy-part1.sh` 挂源、`.config` 启用；默认只带 SS/SSR-libev 客户端 + Simple-Obfs + Trojan-Plus，Xray/Sing-Box/Geodata 等大内核在 `.config` 的 `INCLUDE_*` 开关里关闭。
- **换分支**：`openwrt-builder.yml` 里 `REPO_BRANCH` 改成 `openwrt-24.10` 等；
  换分支后务必先看 `Verify 32M patch` 那步，确认上游 DTS/分区结构没变（脚本找不到文件会直接失败，不会静默出 16M 固件）。

---

## 七、扩容不止改固件：32MB / 64MB 到底还要动什么

固件只占三分之一，剩下三分之二在芯片、Bootloader 和验证上。

### 7.1 32MB（本次目标）

**A. 芯片（硬件，必须自己确认）**

- 容量 32MB（256Mbit）NOR，**必须支持 4 字节地址**（W25Q256 / GD25Q256 / XM25QH256C 这类）
- 封装要能落到 HC5761 的 **SOP-8 208mil** 焊盘：GD25Q256C、XM25QH256C 有 SOP-8 版本；
  W25Q256JV 多为 SOIC-16 / WSON8，直接装不上（要转接板）
- 注意 SOP-8 208mil 与 150mil 宽度不同，买错焊不上

**B. 换片流程（新片是空白片，只焊上去不会启动）**

1. 拆原片前用编程器做 **full dump（16MB 全片）** 留底——art 就在里面，丢了就没 MAC、没无线
2. 编程器往新片写：`breed-mt7620-hiwifi-hc5761.bin` → 偏移 0x0（占 0x0–0x30000）
   - 型号别搞错：极壹S/极贰(HC5661/HC5761) 专用版，**115200 波特率，复位键 GPIO#12**；
     通用 `reset1` 版是 GPIO#1，按键对不上进不去 Breed
3. 再写你的 art 到 **0x40000（64K）**
4. 焊上新片 → 进 Breed → 刷 `...-squashfs-sysupgrade.bin`

**C. 固件（本仓库已完成）**

- DTS：firmware `0x50000 → 0x2000000`，前三个分区不动
- `IMAGE_SIZE := 32448k`

**D. 软件/环境（基本不用动）**

- art/MAC 仍在 0x40000 → MAC、无线校准自动沿用，不需要改任何 MAC 相关代码
- Breed 里旧的 `bootargs` / `mtdparts` 环境变量必须清空（冲突会起不来）
- 16M → 32M 只能 Breed 刷固件（跨尺寸不能走 sysupgrade）；以后 32M → 32M 用 sysupgrade 正常

**E. 刷完必须验证 4B 真的生效（4 条命令）**

```sh
cat /proc/mtd                                  # firmware 必须是 01fb0000
dmesg | grep -iE 'spi-nor|m25p80'              # 应能看出 32768 KiB
df -h /overlay                                 # 约 30MB 可用
dd if=/dev/zero of=/overlay/t.bin bs=1M count=20 && rm -f /overlay/t.bin
```

最后一条是**关键**：它能写穿 16MB 边界，才证明 4 字节寻址真的可用；
前三条过、这条失败，说明只用到前 16MB。

**F. 两个真机坑（32M 特有）**

1. **软重启可能卡死**：4B 模式下如果驱动没在关机时把 flash 切回 3B 模式，
   MT7620A 重新上电按 3B 读 → 卡在启动（断电可恢复，不是砖）。
   刷完先手动 `reboot` 试一次；会卡就说明踩到了，需要驱动 shutdown 补丁（发 Exit-4B 命令）。
2. **降频兜底**：飞线/转接后 50MHz 时序可能不稳（表现为 CRC 报错、偶发起不来）。
   把 32m dtsi 里 `spi-max-frequency = <50000000>` 改成 `<25000000>` 即可。
   本仓库的补丁脚本可以在这一行上一并处理。

### 7.2 64MB 会怎么样

- **理论上可以**：MT7620A 的 SPI 是 3B 模式 16MB / 4B 模式 **64MB（512Mbit）** 上限
- **固件数字**：firmware `0x50000 → 0x4000000` = `0x3FB0000` → `IMAGE_SIZE := 65216k`，
  其余做法和 32M 完全一样（改 dtsi + 改 mk）
- **真正的瓶颈在芯片**：64MB NOR 基本只有 **SOIC-16 300mil / WSON8**（W25Q512JV 一类），
  **SOP-8 208mil 焊盘装不上**，必须转接板或飞线 → 机械风险、时序问题陡增
- **内核要认得**：spi-nor 靠 SFDP 或内置 ID 表认出 512Mbit，认不出就按 16MB 用
- **Breed 只操作低 16MB 区**（Breed 0x0、art 0x40000、固件 0x50000），所以刷写本身不受影响，
  但它的容量识别可能只显示 16M（不影响刷机，只影响心里踏实）
- **收益**：overlay 从 ~30MB 涨到 ~62MB；可 128MB 内存 + 580MHz + 百兆口装不了 docker，
  多出来的空间主要用来多塞几个插件
- **结论**：能做，但不值。32MB 是这块板子的甜点，64MB 属于折腾成本翻倍、体验提升有限

### 7.3 怎么离线确认一个 sysupgrade.bin 到底是不是 32M 版

**不能凭文件大小判断**：16M 和 32M 版编出来的镜像都只有 9MB 左右（squashfs 只装包，不占满分区）。
但固件自带 DTB，分区表就在里面，可以这么验：

1. 前 64 字节是 uImage 头，magic `27 05 19 56`，第 12–15 字节（大端）= 内核载荷长度
2. 载荷是 LZMA（alone 格式），解压后**末尾追加了 DTB**（magic `d0 0d fe ed`）
3. 在 DTB 里找 `label = "firmware"` 节点的 `reg`：
   - `0x50000 0x1FB0000` → 32MB 版 ✅
   - `0x50000 0x0F7000` → 16MB 原版 ❌（多出来的 16MB 用不到）
4. 顺便确认 "载荷后面紧跟 squashfs 魔数 `hsqs`"（偏移 0），说明是 uImage+squashfs 裸拼接、Breed 可直接写

**本仓库 release `2026.11.13-2338` 的实测结果：**

```
镜像 9765683 bytes (9.31 MB)
uImage: "MIPS ImmortalWrt Linux-5.15.198", comp=3(LZMA), 载荷 2317341 bytes
载荷后 squashfs 魔数偏移 0  -> 裸拼接，Breed 可直接写 0x50000
DTB: model = HiWiFi HC5761
  u-boot   0x00000000 - 0x00030000   192K
  hw_panic 0x00030000 - 0x00040000    64K
  factory  0x00040000 - 0x00050000    64K
  firmware 0x00050000 - 0x02000000 32448K
总长 0x2000000（32MB），无重叠 -> 这是真正的 32MB 版本
```

## 八、LuCI 换皮：Argon（已配好，你不用动手）

默认 LuCI 是 bootstrap，就是那个灰白、方角、很不像 2025 年的界面。换成 **Argon**（就是大多数人刷 ImmortalWrt 后看到的那个带渐变壁纸、圆角、毛玻璃的界面）。

### 8.1 只动了两个地方

| 文件 | 改动 |
|---|---|
| `.config` | `CONFIG_PACKAGE_luci-theme-argon=y`、`CONFIG_PACKAGE_luci-app-argon-config=y`、`CONFIG_PACKAGE_wget-ssl=y` |
| `files/etc/uci-defaults/99-luci-theme`（新增，755；原 99-luci-argon） | 首次开机把 `luci.main.mediaurlbase` 从 `/luci-static/bootstrap` 改成 `/luci-static/argon` |

**为什么不用 git clone 第三方主题源**：ImmortalWrt 23.05 自带的 luci 源里就有
`luci-theme-argon` 2.4.2 和 `luci-app-argon-config`（都已核对过上游 Makefile），
直接开 CONFIG 最稳。自己 `git clone jerrykuku/luci-theme-argon` 会踩两个坑：
master 已是 3.1.x（依赖 ucode-mod-math / coreutils-timeout，和 23.05 的 LuCI 代沟）、
以及和源内同名包冲突导致 `duplicate package` 编译失败。

### 8.2 刷完你会看到

- 登录页和后台都是 Argon，中文界面照旧
- **系统 → Argon 主题配置**：壁纸（可上传自己的图，支持多张轮换）、毛玻璃模糊强度、深色模式、主色调、菜单折叠
- 体积约 1.5MB，当前镜像才 9.3MB / 32448K，塞得下

### 8.3 想手工改 / 想退回 bootstrap

```sh
# 改深色 + 关毛玻璃（改完清浏览器缓存或重启 uhttpd）
uci set argon.global.mode='dark'
uci set argon.global.blur='0'
uci commit argon
/etc/init.d/uhttpd restart

# 退回 bootstrap
uci set luci.main.mediaurlbase='/luci-static/bootstrap'
uci commit luci
/etc/init.d/uhttpd restart
```

### 8.4 注意

- 换主题必须**重新跑一次 Actions 编译**，不能只刷旧固件（包里没这个主题）。ccache 命中后约 40 分钟。
- 已刷的 32M 固件（release `2026.11.13-2338`）里没有 Argon，想用就得等新包。

## 九、32MB 的软重启卡死：已修（加一行 DTS 属性，不动内核源码）

### 9.1 现象

`reboot` 之后整机没反应：指示灯不亮、ping 不通，**拔电源等 30 秒再插电就恢复正常**。

这不是刷坏，是 32MB 的已知副作用。

### 9.2 原因

内核发现 flash 容量超过 16MB 时，会把地址位宽切到 4 字节。`w25q256`（JEDEC `0xef4019`）其实对应两种片子，靠 SFDP 版本区分：

| 变体 | SFDP | 内核行为 | 软重启 |
|---|---|---|---|
| W25Q256**JV** | JESD216A | 置 `SNOR_F_4B_OPCODES`，用 4B 指令码逐次读写，**不进模式** | 正常 |
| W25Q256**FV** | 老版本 | 发 `0xB7`(EN4B)，让**整片**进入 4 字节地址模式 | **卡死** |

这个 4 字节模式是易失状态，**只有断电才复位**。reboot 时 Breed 用 3 字节命令读 flash，读不到就直接躺下。

### 9.3 内核里本来就有逃生门，只是默认关着

`spi_nor_shutdown()`（reboot 时由 `device_shutdown()` 调用）→ `spi_nor_restore()`，而 restore 里退出 4 字节模式的条件是：

```
nor->addr_width == 4 && !(nor->flags & SNOR_F_4B_OPCODES) && nor->flags & SNOR_F_BROKEN_RESET
```

`SNOR_F_BROKEN_RESET` **只来自 DTS 的 `broken-flash-reset` 属性**。上游 dtsi 没写，所以退出逻辑从来没跑过。

另外 Winbond 的实现 `winbond_set_4byte_addr_mode(false)` 还会补一步 **清 EAR=0**：FV 版退出 4B 后扩展地址寄存器会残留 1，那样所有 3 字节读都会落到后半片——这本身也是个起不来的坑，靠这个属性一起解决。

### 9.4 改了什么（两处）

1. `diy-part2.sh`：在生成的 32M dtsi 中，给 `flash@0` 节点插一行 `broken-flash-reset;`（带锚点校验，找不到 `jedec,spi-nor` 就 `exit 1`，不会白跑编译）
2. 工作流 `Verify 32M patch` 步骤加了自检：`broken-flash-reset;` 必须恰好出现 1 次，否则构建当场失败

生成结果（已本地对真实上游文件回归通过）：

```dts
&spi0 {
	status = "okay";

	flash@0 {
		compatible = "jedec,spi-nor";
		broken-flash-reset;          /* ← 新增，就这一行 */
		reg = <0>;
		spi-max-frequency = <50000000>;
		m25p,fast-read;
```

**不改内核、不改上游 dtsi**，对 16MB 原版和其他 mt7620 设备零影响。

### 9.5 刷完怎么验（两步）

```sh
# 1) 确认属性进了 DTB（开机 dmesg 会多一条 WARN，属正常提示，不影响功能）
dmesg | grep -i 'reset hack'
# 期望：enabling reset hack; may not recover from unexpected reboots

# 2) 真·软重启测试
reboot
```

起来后 `uptime` 是新的、SSH 能进、无线能连 = 修好了。以后再升级固件、点 LuCI 的“重启”都可以直接用。

### 9.6 万一还是卡死

说明这条路径没走到（例如芯片是 JV 变体却仍异常）。下一手是把内核里 `spi_nor_restore()` 的条件放开（无条件发 `0xE9`），需要改内核源码、多一次编译。**任何情况下都不会变砖**：断电 30 秒插回即可恢复。

---

## 十、服务插件 + 主题（照参考图 R21.2.1 补的）

参考图是老的 LEDE R21.2.1（内核 5.4.95、LuCI git-21.035），皮肤是 **luci-theme-material**。ImmortalWrt 23.05 的 luci 源里这些包大部分自带，不需要加第三方源。

### 10.1 主题：默认 Argon（iStoreOS 同款）

iStoreOS 后台用的就是 **Argon**（易有云官方更新日志里直接写“默认主题 Argon”），ImmortalWrt 的 luci 源本来就带 `luci-theme-argon` 2.4.2 + `luci-app-argon-config`，不需要第三方源。

| 外观 | 主题包 | 状态 |
|---|---|---|
| 蓝白卡片 + 左侧边栏（iStoreOS 那种） | `luci-theme-argon` | **默认** |
| 青色顶栏（老 LEDE 风格，参考图那款） | `luci-theme-material` | 已装，仅备用 |

两个主题共存，切换不用重编固件：

```sh
# 切到 Argon（iStoreOS 同款）
uci set luci.main.mediaurlbase='/luci-static/argon'; uci commit luci; /etc/init.d/uhttpd restart

# 切回 Material（青色顶栏那款）
uci set luci.main.mediaurlbase='/luci-static/material'; uci commit luci; /etc/init.d/uhttpd restart

# 看当前是哪个
uci get luci.main.mediaurlbase
```

#### 想要 iStoreOS 那种干净蓝白，再补两条（立即生效，不用重编）

```sh
uci set argon.@global[0].primary='#2f7ef7'
uci set argon.@global[0].online_wallpaper='none'
uci commit argon
/etc/init.d/uhttpd restart
```

- `primary`：主色调。Argon 默认是 `#5e72e4`（偏紫），换成 `#2f7ef7` 是干净的正蓝
- `online_wallpaper='none'`：登录页不拉 Bing 风景图，纯色背景，加载更快也不会白屏等图
- 其余项在 **系统 → Argon 主题设置** 里可视化改：浅色/深色/自动模式、模糊、透明度、自定义登录背景图与视频、自定义 Logo

浏览器 Ctrl+F5 强刷一次，否则看到的是缓存里的旧皮肤。

配套的文件：

| 仓库路径 | 作用 |
|---|---|
| `files/etc/uci-defaults/99-luci-theme` | 开机把 `luci.main.mediaurlbase` 设成 argon（退回 material → bootstrap） |
| `files/etc/uci-defaults/99-argon-look` | 开机把 argon 主色设成 `#2f7ef7`、登录页背景设成 none |

### 10.2 参考图 8 个服务项：装 5 个（4 基础 + Passwall），去掉 2 个（ddns、adbyby），不开/装不了 2 个

| 参考图菜单名 | 实际包名 | 依赖（自动装） | 状态 |
|---|---|---|---|
| 网络唤醒 | `luci-app-wol` | etherwake | ✅ 已装 |
| UPnP | `luci-app-upnp` | miniupnpd + rpcd-mod-ucode | ✅ 已装 |
| KMS 服务器 | `luci-app-vlmcsd` | vlmcsd | ✅ 已装 |
| 迅雷快鸟 | `luci-app-xlnetacc` | jshn + wget-ssl + openssl-util（纯脚本） | ✅ 已装 |
| 科学上网 | `luci-app-passwall` | SS/SSR-libev 客户端、Simple-Obfs、Trojan-Plus、chinadns-ng、dnsmasq-full | ✅ 已装 |
| 广告屏蔽大师 Plus+ | `luci-app-adbyby-plus` | adbyby + ipset + **dnsmasq-full** + dos2unix | 🚫 主动移除 |
| 解锁网易云灰歌 | `luci-app-unblockneteasemusic` | **+node** + dnsmasq-full + firewall4 | ⚠️ 默认不开 |
| 上网时间控制 | — | — | ❌ 源里没有 |

#### 为什么去掉 adbyby

两个独立原因：规则服务器早已停更（装了大概率“能开但没规则”）；它硬依赖 `dnsmasq-full`，会把系统默认的 `dnsmasq` 顶掉，刷完你原来手改的 DNS/DHCP 配置全部失效。**adbyby 摘掉后不再为它单独拉 `dnsmasq-full`；注意 Passwall 自身依赖 `dnsmasq-full`，装了 Passwall 后系统仍是 `dnsmasq-full`。**

要广告拦截就开 `.config` 末尾那两行注释之一：

- `luci-app-adblock-fast` —— 走 dnsmasq 的 hosts/解析层过滤，不动 dnsmasq 本体，内存占用小，适合 128MB 机器；
- `luci-app-adguardhome` —— 独立进程 + 自带面板，效果强但吃内存（建议配 swap / 外置 U 盘）。

#### 另外两个装不上的

- **解锁网易云**：包在源里，但依赖 Node.js。MT7620A 只有 580MHz / 128MB，node 体积十几 MB、常驻内存也大，默认不开；真要就取消 `.config` 里那行注释。
- **上网时间控制**：ImmortalWrt 的 luci 源里根本没有这个包（只有 LEDE/coolsnowwolf 的 `luci-app-accesscontrol` 才有），要装必须加第三方源，跨内核版本容易编不过。源里看着像但**功能不同**的有：`luci-app-wifischedule`（WiFi 定时开关）、`luci-app-nft-qos`（限速）、`luci-app-cpulimit`（CPU 限制）。

### 10.3 .config 里新增的原文

```ini
CONFIG_PACKAGE_luci-theme-material=y
CONFIG_PACKAGE_luci-theme-argon=y
CONFIG_PACKAGE_luci-app-argon-config=y
CONFIG_PACKAGE_wget-ssl=y

CONFIG_PACKAGE_luci-app-wol=y
CONFIG_PACKAGE_luci-app-upnp=y
CONFIG_PACKAGE_luci-app-vlmcsd=y
CONFIG_PACKAGE_luci-app-xlnetacc=y

CONFIG_PACKAGE_luci-i18n-wol-zh-cn=y
CONFIG_PACKAGE_luci-i18n-upnp-zh-cn=y
CONFIG_PACKAGE_luci-i18n-vlmcsd-zh-cn=y
CONFIG_PACKAGE_luci-i18n-xlnetacc-zh-cn=y
```

注意：**每条 CONFIG 后面都不能写行尾注释**，kconfig 只认整行以 `#` 开头的注释，`CONFIG_XXX=y  # 说明` 这种写法会让整行失效、插件静默消失。

### 10.4 体积与编译时间

4 个基础 app 全是 `PKGARCH:=all` 前端 + 几百 KB 小二进制；Passwall 按 23.05/mipsel 实际 ipk 体积核算：内核与辅助程序约 0.94MB（trojan-plus 370KB、chinadns-ng 292KB、SS/SSR-libev 与 obfs 均几十 KB），加面板与依赖合计 **+2.2~2.6MB**（ipk 压缩口径）。基线 sysupgrade 10.31MB，加 Passwall 后预计 **12~13MB**，32MB 分区余量充足。编译时间不变（ccache 命中约 40 分钟）。

### 10.5 刷完验收

```sh
# 1) 主题应为 material
uci get luci.main.mediaurlbase
# 期望：/luci-static/material

# 2) 两个主题目录都在
ls /www/luci-static/ | tr '\n' ' '
# 期望里面能看到 argon 和 material

# 3) 四个基础服务插件 + Passwall 都装上了
opkg list-installed | grep -E 'luci-app-(wol|upnp|vlmcsd|xlnetacc|passwall)'

# 4) Passwall 依赖 dnsmasq-full（出现 dnsmasq-full 属正常）
opkg list-installed | grep dnsmasq
```

LuCI 登录后「服务」菜单下应出现：网络唤醒、UPnP、KMS 服务器、迅雷快鸟，以及「Passwall」。

## 十一、LuCI 里直接看 Flash 大小（自建「Flash 信息」页）

### 11.1 先给结论：没有现成插件干这件事

把 23.05 源翻了一遍，能沾边的都不对口：

| 源里的东西 | 它能看什么 | 为什么不算「Flash 查看器」 |
|---|---|---|
| `luci-mod-dashboard`（首页大盘） | 路由 / LAN / WiFi 三块卡片 | 没有存储卡片 |
| `luci-app-diskman`（磁盘管理） | U 盘、移动硬盘的分区表 | 读 `/sys/block`，SPI NOR 是 `/dev/mtdblockN`，不在里面 |
| `luci-app-netdata` / `luci-app-statistics` | 系统负载、df 曲线图 | 只画 `/overlay` 已用量，看不到芯片总容量 |
| 自带「状态 → 概览」 | `磁盘空间 696 KiB / 21.81 MiB` | 这是 overlay 分区，不是 32MB 芯片 |
| 自带「系统 → 挂载点」 | `/dev/mtdblock6 → /overlay` | 只有挂载点，没有分区总表 |

**芯片真实容量只出现在 `dmesg` 的 `spi-nor spi0.0: w25q256 (32768 Kbytes)` 这一行**，没有任何 LuCI 包去解析它。所以直接在 `files/` 里给你塞了一个自建页面，随固件打包，不用装包、不占 opkg 空间。

### 11.2 位置与内容

登录 LuCI → **状态 → Flash 信息**（原来的菜单里会多一项，排在其他状态项之后）。

页面就两块：

1. **Flash 总容量（顶层分区合计）**：`32.00 MiB`，下面附 `33554432 字节 / 0x2000000（基准：16MB=16777216，32MB=33554432，64MB=67108864）`。
2. **分区表**：设备 / 名称 / 大小 / 十六进制 / 擦除块 / 类型六列，`kernel`、`rootfs`、`rootfs_data` 标为「固件内子分区」，**不重复计入总量**（否则会算出 32MB + 8MB 的假数字）。

数据源只有 `/proc/mtd` 一个文件，开机实时读，不缓存。

表格样式：全列居中、固定列宽（11/21/14/22/12/20%）、表头淡蓝底、隔行浅色、悬停高亮；小于 1MiB 的分区按 KiB 显示（u-boot 0x30000 显示 192 KiB），设备名与十六进制用等宽字体，顶层/子分区用绿/褐标签区分。

### 11.3 实现（3 个文件，全在 files/ 里）

| 仓库路径 | 作用 |
|---|---|
| `files/www/luci-static/resources/view/flashinfo.js` | 页面本体，解析 `/proc/mtd` 并渲染表格 |
| `files/usr/share/luci/menu.d/luci-app-flashinfo.json` | 菜单项：`admin/status/flash`，标题「Flash 信息」，order 70 |
| `files/usr/share/rpcd/acl.d/luci-app-flashinfo.json` | 授权：允许读 `/proc/mtd`（LuCI 默认只给目录 list 权限，不给文件 read） |

第二个文件里 `"depends": { "acl": [ "luci-app-flashinfo" ] }` 必须和第三个文件的键名一致，否则菜单项会被隐藏——这是自建 LuCI 页面最常见的坑。

### 11.4 本地已验证

用你上次贴回来的真实 `/proc/mtd` 内容跑同一套解析逻辑，输出：

```
mtd0 u-boot   0.19MiB  0x00030000  顶层
mtd1 hw_panic 0.06MiB  0x00010000  顶层
mtd2 factory  0.06MiB  0x00010000  顶层
mtd3 firmware 31.69MiB 0x01FB0000  顶层
mtd4 kernel   2.21MiB  0x00235C5D  子分区
mtd5 rootfs   29.48MiB 0x01D7A3A3  子分区
mtd6 rootfs_data 21.81MiB 0x015D0000 子分区
总容量 = 33554432 字节 = 32.00 MiB = 0x2000000  → 32MB 正确
```

`node --check` 过语法、两个 JSON 过 `JSON.parse`，blob 里 CR=0（已把 `files/** text eol=lf` 加进 `.gitattributes`，避免 CRLF 被带进镜像）。

### 11.5 不想点网页时的等价命令

```sh
cat /proc/mtd                                   # 分区表
dmesg | grep spi-nor                            # 芯片型号与真实容量：w25q256 (32768 Kbytes)
df -h /overlay                                  # 可用 overlay（21.8M 就是扩容生效的证据）
```

### 11.6 万一菜单没出现

```sh
# 1) 三个文件在不在
ls -l /www/luci-static/resources/view/flashinfo.js
ls -l /usr/share/luci/menu.d/luci-app-flashinfo.json
ls -l /usr/share/rpcd/acl.d/luci-app-flashinfo.json

# 2) 清浏览器缓存 / 重启 rpcd 与 uhttpd
/etc/init.d/rpcd restart; /etc/init.d/uhttpd restart
```

如果页面能打开但提示无法读取，说明 acl 没生效（rpcd 重启即可）；页面本身不会影响开机和上网。
---

## 十二、图形化仪表盘（自建「仪表盘」页，零依赖）

### 12.1 先划清边界：哪些能改、哪些改不了

- **改不了**：LuCI 每个功能页的排版是各 app 自带的 JS/CBI 表单自动生成的（字段顺序、分组、按钮位置都在包里写死），主题只能统一配色、字体、圆角、间距，**没法逐页重排**。想要「所有页面布局都重新设计」等于改几十个 app 的源码，不现实也没必要。
- **能改的只有三层**：① 主题层（Argon 的 CSS 与配色，已生效）② 自建页面（想怎么排就怎么排）③ 装带图表的插件。
- 所以本次交付 = 主题维持 Argon（iStoreOS 同款）+ **新增一个图形化仪表盘页**，把「信息显示更合理、图表直观」这件事落到能看得见的地方。

### 12.2 新页面：状态 → 仪表盘

菜单 `admin/status/dash`，order 5，排在「概览」前面；访问 `/cgi-bin/luci/` 时大概率直接落到这一页（若不是，地址栏直接输 `/admin/status/dash`）。

上面 4 张指标卡：

| 卡片 | 显示内容 |
|---|---|
| CPU 使用率 | 实时百分比 + 60 次采样折线（每 4 秒一点），副标题显示核数与采样方式 |
| 内存占用 | 百分比 + 折线，副标题 `已用 / 总量`（如 57.6 MiB / 116.4 MiB） |
| 实时网速 | `↓ 1.00 MB/s  ↑ 256.0 KB/s`（B/s→KB/s→MB/s 自动换算），副标题显示统计接口名 |
| 运行时间 / 负载 | `3 小时 25 分` + `负载 0.99 / 1.73 / 0.87` |

下面 3 块图：

| 图 | 说明 |
|---|---|
| 近 60 次采样网速曲线 | 双线：蓝=下行、绿=上行，y 轴按当前峰值自适应，避免小流量被压成一条直线 |
| 内存构成环形图 | 已用（蓝）/ 缓存（黄）/ 可用（灰），下方带图例与数值 |
| Flash 存储 | 大数字 `32.00 MiB` + 堆叠条（u-boot / hw_panic / factory / firmware）+ 图例带各自容量 |

底部信息条：型号（读 `/proc/device-tree/model`）、内核版本（读 `/proc/version`）、CPU 核数。

刷新策略：每 4 秒一次；`/proc/mtd`、`/proc/version`、`/proc/device-tree/model` 这三个静态数据**只读一次**，其余每轮读，避免在 580MHz 上频繁打扰 rpcd。

### 12.3 三个文件（随 files/ 打包，不装包、不占额外 flash）

| 文件 | 作用 |
|---|---|
| `files/www/luci-static/resources/view/dash.js` | 页面本体：解析 /proc、画 canvas、4 秒轮询 |
| `files/usr/share/luci/menu.d/luci-app-dash.json` | 菜单项：`admin/status/dash`、标题「仪表盘」、order 5 |
| `files/usr/share/rpcd/acl.d/luci-app-dash.json` | 放行 8 个 /proc 文件的 read |

数据全部来自 `/proc`（`stat`、`meminfo`、`net/dev`、`uptime`、`loadavg`、`mtd`、`version`、`device-tree/model`），不需要 ubus、不需要装 collectd，也不占额外 flash（页面本身 14KB，直接躺在只读分区里）。

### 12.4 为什么不用现成插件

- `luci-mod-dashboard`：官方大盘，但只有「路由器 / LAN / WiFi」三张卡片，**一张图表都没有**。
- `luci-app-statistics`（collectd + rrdtool）：能给真正的历史曲线，代价约 +2MB flash、常驻 collectd 进程、每 5 分钟 rrd 落盘；580MHz/128MB 上属于「能用但吃紧」。
- 自建页的优点：零成本、能显示 Flash 分区布局（统计插件看不到 mtd 顶层分区）。

想要历史曲线（比如 24 小时流量）再上 statistics，在 `.config` 加这几行重编一次即可（默认没启用，避免白占 2MB）：

```
CONFIG_PACKAGE_luci-app-statistics=y
CONFIG_PACKAGE_collectd-mod-cpu=y
CONFIG_PACKAGE_collectd-mod-memory=y
CONFIG_PACKAGE_collectd-mod-interface=y
CONFIG_PACKAGE_collectd-mod-load=y
CONFIG_PACKAGE_rrdtool1=y
```

### 12.5 本地已验证（不是「写完就交」）

- `node --check` 语法通过；
- 用真实格式的 `/proc` 样本喂进去跑：CPU 71.9%、内存 57.6 MiB / 116.4 MiB、下行 1.00 MB/s、上行 256.0 KB/s、Flash 32.00 MiB、7 个分区（顶层 4）；
- 结构树 6 个顶层节点、5 个 canvas 全部产生绘制调用（clearRect / stroke / fill / arc / fillRect），无 unhandled rejection。

### 12.6 设备端更新（免重编，1 分钟生效）

```sh
cd /tmp
B=https://raw.githubusercontent.com/YanYanLun/Actions-OpenWrt/hc5761-openwrt-23.05/files
wget -q -O /www/luci-static/resources/view/dash.js $B/www/luci-static/resources/view/dash.js
wget -q -O /usr/share/luci/menu.d/luci-app-dash.json $B/usr/share/luci/menu.d/luci-app-dash.json
wget -q -O /usr/share/rpcd/acl.d/luci-app-dash.json $B/usr/share/rpcd/acl.d/luci-app-dash.json
/etc/init.d/rpcd restart
/etc/init.d/uhttpd restart
```

然后刷新网页 → 状态 → 仪表盘。三个文件都走 overlay copy-up，不用重启路由器；`sysupgrade` 后回到镜像自带版本（镜像里已经是同一份）。

### 12.7 想更接近 iStoreOS 的「扁平干净」

Argon 默认侧边栏带 30% 透明 + 毛玻璃残留，想要 iStoreOS 那种纯色扁平感，SSH 跑这两条（立即生效，不用重编）：

```sh
uci set argon.@global[0].transparency='0'
uci set argon.@global[0].blur='0'
uci commit argon
/etc/init.d/uhttpd restart
```

主色已是 `#2f7ef7`（iStoreOS 同款蓝），登录页背景已设为纯色不拉 Bing 图。

---
## 十三、来源与致谢

- 本仓库 fork 自 [P3TERX/Actions-OpenWrt](https://github.com/P3TERX/Actions-OpenWrt) 模板（MIT License © P3TERX），工作流骨架、ccache 与 release 上传逻辑沿用该模板。
- 源码：[immortalwrt/immortalwrt](https://github.com/immortalwrt/immortalwrt) `openwrt-23.05` 分支；LuCI 与 packages 均为 ImmortalWrt 官方 feed。
- 主题：[jerrykuku/luci-theme-argon](https://github.com/jerrykuku/luci-theme-argon)（仓库内由 ImmortalWrt feed 提供，未单独 fork）。
- 构建：[GitHub Actions](https://github.com/features/actions)。
- 许可证文件 `LICENSE` 保留原模板的 MIT 文本。
