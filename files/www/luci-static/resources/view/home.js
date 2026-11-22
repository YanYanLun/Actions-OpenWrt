'use strict';

'require view';
'require fs';
'require rpc';

var NESTED = /^(kernel|rootfs|rootfs_data)$/;
var HIST = 60;
var POLL_MS = 1000;      /* 采样间隔 */
var TEXT_MS = 33;        /* 数字 30fps */
var DRAW_MS = 33;        /* 曲线 30fps */
var GRID_MS = 250;       /* 坐标轴层 4fps：刻度跟着曲线一起滑，几乎不耗 */
var TAU_MS = 300;        /* 数值跟随时间常数：永不定格，连续逼近 */

var NET_W = 640, NET_H = 184;
var MINI_W = 320, MINI_H = 72;
var PAD = { l: 14, r: 12, t: 10, b: 12 };

var PAGE_TITLE = '首页';

var callSystemInfo = rpc.declare({ object: 'system', method: 'info' });
var callNetDump = rpc.declare({ object: 'network.interface', method: 'dump', expect: { 'interface': [] } });
var callNetDevs = rpc.declare({ object: 'luci-rpc', method: 'getNetworkDevices' });

function parseCpu(txt) {
	var m = (txt || '').match(/(?:^|\n)cpu\s+([^\n]+)/);

	if (!m)
		return null;

	var v = m[1].trim().split(/\s+/).map(Number);

	return {
		busy: (v[0] || 0) + (v[1] || 0) + (v[2] || 0) + (v[5] || 0) + (v[6] || 0) + (v[7] || 0),
		total: (v[3] || 0) + (v[4] || 0) + (v[0] || 0) + (v[1] || 0) + (v[2] || 0) + (v[5] || 0) + (v[6] || 0) + (v[7] || 0)
	};
}

function cpuPercent(prev, cur) {
	if (!prev || !cur)
		return null;

	var dt = cur.total - prev.total;

	if (dt <= 0)
		return null;

	return Math.max(0, Math.min(100, (cur.busy - prev.busy) * 100 / dt));
}

function parseMem(txt) {
	var o = {};

	(txt || '').split('\n').forEach(function(l) {
		var m = l.match(/^(\w+):\s+(\d+)\s*kB/i);

		if (m)
			o[m[1]] = Number(m[2]) * 1024;
	});

	if (!o.MemTotal)
		return null;

	var avail = (o.MemAvailable !== undefined) ? o.MemAvailable : (o.MemFree || 0),
	    cache = (o.Buffers || 0) + (o.Cached || 0);

	return {
		total: o.MemTotal,
		avail: avail,
		used: o.MemTotal - avail,
		cache: Math.min(cache, avail),
		free: Math.max(0, avail - cache)
	};
}

function parseNet(txt) {
	var best = null;

	(txt || '').split('\n').forEach(function(l) {
		var p = l.split(':');

		if (p.length !== 2)
			return;

		var name = p[0].trim(),
		    f = p[1].trim().split(/\s+/);

		if (!name || name === 'lo' || f.length < 9)
			return;

		var rx = Number(f[0]),
		    tx = Number(f[8]);

		if (!isFinite(rx) || !isFinite(tx))
			return;

		if (!best || rx + tx > best.rx + best.tx)
			best = { name: name, rx: rx, tx: tx };
	});

	return best;
}

function ifcCidr(ifc) {
	var a = ifc && ifc['ipv4-address'];
	return (Array.isArray(a) && a.length && a[0].address) ? a[0].address + '/' + a[0].mask : null;
}

function ifcGw(ifc) {
	var rt = ifc && ifc.route;
	if (Array.isArray(rt))
		for (var i = 0; i < rt.length; i++)
			if (rt[i] && rt[i].target === '0.0.0.0' && rt[i].mask == 0 && rt[i].nexthop)
				return rt[i].nexthop;
	return null;
}

function ifcDns(ifc) {
	var d = ifc && (ifc['dns-server'] || ifc.dns);
	return Array.isArray(d) ? d : [];
}

function speedText(p) {
	if (!p.carrier) return '—';
	if (!p.speed || p.speed < 0) return '已连接';
	if (p.speed >= 1000) return (p.speed / 1000).toFixed(p.speed % 1000 ? 1 : 0) + ' Gbps';
	return p.speed + ' Mbps';
}

function portIcon(up) {
	var c = up ? '#10a374' : '#c0c6cf';
	return '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="' + c +
		'" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
		'<rect x="4" y="5" width="16" height="11" rx="2"/>' +
		'<path d="M8 16v3M12 16v3M16 16v3"/>' +
		'<path d="M8 9h8"/></svg>';
}

function pickPorts(devs, wanDev, lanDev, wanN, lanN) {
	var ports = [];

	function linkOf(name) { return (devs[name] || {}).link || {}; }

	/* LAN 若是网桥，落到网桥下属的成员口上取链路状态 */
	var lanPhys = lanDev;
	if (lanDev && (devs[lanDev] || {}).type === 'bridge') {
		var phys = Object.keys(devs).filter(function(n) { return devs[n].bridge === lanDev; })[0];
		if (phys) lanPhys = phys;
	}

	var wanLink = linkOf(wanDev),
		lanLink = linkOf(lanPhys);

	for (var i = 0; i < wanN; i++)
		ports.push({ name: 'WAN' + (wanN > 1 ? (i + 1) : ''), role: 'WAN', carrier: !!wanLink.carrier, speed: wanLink.speed, duplex: wanLink.duplex });

	for (var j = 0; j < lanN; j++)
		ports.push({ name: 'LAN' + (lanN > 1 ? (j + 1) : ''), role: 'LAN', carrier: !!lanLink.carrier, speed: lanLink.speed, duplex: lanLink.duplex });

	return ports;
}

function parseMtd(txt) {
	var parts = [];

	(txt || '').split(/\r?\n/).forEach(function(line) {
		var m = line.match(/^(mtd\d+):\s+([0-9a-f]+)\s+([0-9a-f]+)\s+"(.+)"/i);

		if (m)
			parts.push({
				dev: m[1],
				size: parseInt(m[2], 16),
				name: m[4],
				nested: NESTED.test(m[4])
			});
	});

	var total = 0;
	parts.forEach(function(p) {
		if (!p.nested)
			total += p.size;
	});

	return { total: total, parts: parts };
}

function parseUptime(txt) {
	return Number((txt || '').trim().split(/\s+/)[0]) || 0;
}

function parseLoad(txt) {
	return (txt || '').trim().split(/\s+/).slice(0, 3).map(function(x) {
		return Number(x) || 0;
	});
}

function parseKernel(txt) {
	var m = (txt || '').match(/Linux version (\S+)/);
	return m ? m[1] : '未知';
}

function cpuCores(txt) {
	return (txt || '').split('\n').filter(function(l) {
		return /^cpu\d+/.test(l);
	}).length;
}

/* /etc/openwrt_release：固件版本描述 */
function parseRelease(txt) {
	var o = {};

	(txt || '').split(/\r?\n/).forEach(function(l) {
		var m = l.match(/^([A-Z_]+)="?([^"]*)"?$/);

		if (m)
			o[m[1]] = m[2];
	});

	return o.DISTRIB_DESCRIPTION ||
		[ o.DISTRIB_NAME, o.DISTRIB_VERSION, o.DISTRIB_REVISION ].filter(Boolean).join(' ') || '未知';
}

/* /tmp/dhcp.leases：租约里的主机名（列：到期时间 MAC IP 主机名 ClientID） */
function parseLeases(txt) {
	var map = {};

	(txt || '').split(/\r?\n/).forEach(function(l) {
		var p = l.trim().split(/\s+/);

		if (p.length < 4)
			return;

		var mac = p[1].toLowerCase(),
		    ip = p[2],
		    host = p[3];

		if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac))
			return;

		map[ip] = { mac: mac, host: host === '*' ? '' : host };
	});

	return map;
}

/* /proc/net/arp：邻居 IP / MAC / 网卡 */
function parseArp(txt) {
	var arr = [];

	(txt || '').split(/\r?\n/).forEach(function(l) {
		if (/^IP address/i.test(l))
			return;

		var p = l.trim().split(/\s+/);

		if (p.length < 6)
			return;

		var mac = p[3].toLowerCase();

		if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac) || mac === '00:00:00:00:00:00')
			return;

		arr.push({ ip: p[0], mac: mac, dev: p[5], host: '' });
	});

	return arr;
}

/* 按 IP 合并 ARP 邻居与 DHCP 租约，ARP 优先，租约补主机名 */
function mergeClients(arp, leases) {
	var byIp = {},
	    list = [];

	(arp || []).forEach(function(a) { byIp[a.ip] = a; });

	Object.keys(leases || {}).forEach(function(ip) {
		var l = leases[ip];

		if (!byIp[ip])
			byIp[ip] = { ip: ip, mac: l.mac, dev: '', host: l.host };
		else if (!byIp[ip].host)
			byIp[ip].host = l.host;
	});

	Object.keys(byIp).forEach(function(k) { list.push(byIp[k]); });

	list.sort(function(a, b) { return a.ip.localeCompare(b.ip, undefined, { numeric: true }); });

	return list;
}

function devLabel(d) {
	if (!d)
		return '—';

	if (/wlan|ra\d|ath|wifi/i.test(d))
		return '无线';

	if (/eth|br|lan/i.test(d))
		return '有线';

	return d;
}

/* /etc/config/wireless：解析 wifi-device / wifi-iface 配置 */
function parseWireless(txt) {
	var sections = [], cur = null;

	(txt || '').split(/\r?\n/).forEach(function(l) {
		var cfg = l.match(/^config\s+(\S+)\s+(?:'([^']*)'|(\S+))/);

		if (cfg) {
			cur = { type: cfg[1], name: cfg[2] || cfg[3] || '', opts: {} };
			sections.push(cur);
			return;
		}

		if (!cur)
			return;

		var opt = l.match(/^\s*option\s+(\S+)\s+(?:'([^']*)'|"([^"]*)"|(\S+))/);

		if (opt)
			cur.opts[opt[1]] = opt[2] !== undefined ? opt[2] : (opt[3] !== undefined ? opt[3] : opt[4]);
	});

	var devices = {}, ifaces = [];

	sections.forEach(function(s) {
		if (s.type === 'wifi-device' || s.type === 'wifi-radio')
			devices[s.name] = s.opts;
		else if (s.type === 'wifi-iface')
			ifaces.push(s.opts);
	});

	var radios = [], idx = 0;

	Object.keys(devices).sort().forEach(function(name) {
		var d = devices[name],
			iface = ifaces.filter(function(i) { return i.device === name; })[0] || {},
			band = d.band || (/11a|11ac|11ax/i.test(d.hwmode || '') ? '5g' : '2g'),
			ch = Number(d.channel) || 0,
			freq = band === '5g' ? 5000 + ch * 5 : 2407 + ch * 5;

		radios.push({
			radio: name,
			ifname: 'wlan' + idx,
			band: band,
			channel: ch,
			freq: freq,
			htmode: d.htmode || '',
			txpower: d.txpower || '',
			disabled: d.disabled === '1',
			ssid: iface.ssid || '',
			mode: iface.mode || '',
			encryption: iface.encryption || ''
		});
		idx++;
	});

	return radios;
}

/* /etc/config/network：按 switch_vlan 统计 WAN/LAN 物理口数量（剔除 CPU 口 tagged） */
function parseSwitchPorts(txt) {
	var sections = [], cur = null;

	(txt || '').split(/\r?\n/).forEach(function(l) {
		var cfg = l.match(/^config\s+(\S+)(?:\s+'([^']*)'|\s+(\S+))?/);

		if (cfg) {
			cur = { type: cfg[1], name: cfg[2] || cfg[3] || '', opts: {} };
			sections.push(cur);
			return;
		}

		if (!cur)
			return;

		var opt = l.match(/^\s*option\s+(\S+)\s+(?:'([^']*)'|"([^"]*)"|(\S+))/);

		if (opt) {
			cur.opts[opt[1]] = opt[2] !== undefined ? opt[2] : (opt[3] !== undefined ? opt[3] : opt[4]);
			return;
		}

		var lst = l.match(/^\s*list\s+(\S+)\s+(?:'([^']*)'|"([^"]*)"|(\S+))/);

		if (lst) {
			var v = lst[2] !== undefined ? lst[2] : (lst[3] !== undefined ? lst[3] : lst[4]);
			cur.opts[lst[1]] = (cur.opts[lst[1]] ? cur.opts[lst[1]] + ' ' : '') + v;
		}
	});

	var ifDev = {}, vlans = [];

	sections.forEach(function(s) {
		if (s.type === 'interface')
			ifDev[s.name] = s.opts.device || '';
		else if (s.type === 'switch_vlan')
			vlans.push(s.opts);
	});

	function vid(d) { var m = (d || '').match(/\.(\d+)$/); return m ? m[1] : null; }

	function phys(p) {
		return (p || '').split(/\s+/).filter(function(x) { return x && !/t$/i.test(x); });
	}

	var wanVid = vid(ifDev.wan), lanVid = vid(ifDev.lan), out = { wan: 0, lan: 0 };

	vlans.forEach(function(v) {
		var n = phys(v.ports).length,
		    vv = v.vlan || v.vid;
		if (vv === wanVid) out.wan = n;
		else if (vv === lanVid) out.lan = n;
	});

	/* 接口设备是网桥等无 VLAN 后缀时：口数多的 VLAN 归 LAN，少的归 WAN */
	if ((!out.wan || !out.lan) && vlans.length >= 2) {
		var sorted = vlans.slice().sort(function(a, b) {
			return phys(b.ports).length - phys(a.ports).length;
		});
		if (!out.lan) out.lan = phys(sorted[0].ports).length;
		if (!out.wan) out.wan = phys(sorted[sorted.length - 1].ports).length;
	}

	return out;
}

/* /proc/net/dev 里的无线网卡名（按名称排序，与 radio 顺序对齐） */
function wlanIfaces(txt) {
	var out = [];

	(txt || '').split('\n').forEach(function(l) {
		var p = l.split(':'),
		    n = p[0] && p[0].trim();

		if (/^wlan/i.test(n))
			out.push(n);
	});

	return out.sort();
}

function bandLabel(band) {
	return band === '5g' ? '5 GHz' : '2.4 GHz';
}

function encLabel(e) {
	if (!e || e === 'none')
		return '开放';
	if (/psk2|wpa2/i.test(e))
		return 'WPA2-PSK';
	if (/wpa3|sae/i.test(e))
		return 'WPA3';
	return e;
}

function modeLabel(m) {
	if (m === 'ap')
		return 'Master';
	if (m === 'sta')
		return 'Station';
	return m || '—';
}

function widthLabel(ht) {
	var m = (ht || '').match(/(\d+)/);
	return m ? m[1] + ' MHz' : '—';
}

function mib(b) {
	return (b / 1048576).toFixed(2) + ' MiB';
}

function bytes(b) {
	if (b >= 1073741824) return (b / 1073741824).toFixed(2) + ' GiB';
	if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MiB';
	if (b >= 1024) return (b / 1024).toFixed(0) + ' KiB';
	return b + ' B';
}

function rate(bps) {
	if (bps >= 1048576) return (bps / 1048576).toFixed(2) + ' MB/s';
	if (bps >= 1024) return (bps / 1024).toFixed(1) + ' KB/s';
	return bps.toFixed(0) + ' B/s';
}

function shortRate(kbps) {
	if (kbps >= 1024) return (kbps / 1024).toFixed(1) + ' MB/s';
	if (kbps >= 1) return kbps.toFixed(0) + ' KB/s';
	return '0';
}

function clockText(ms) {
	var d = new Date(ms),
	    mm = d.getMinutes(),
	    ss = d.getSeconds();

	return (mm < 10 ? '0' + mm : mm) + ':' + (ss < 10 ? '0' + ss : ss);
}

function uptimeText(sec) {
	var d = Math.floor(sec / 86400),
	    h = Math.floor((sec % 86400) / 3600),
	    m = Math.floor((sec % 3600) / 60);

	if (d > 0) return d + ' 天 ' + h + ' 小时';
	if (h > 0) return h + ' 小时 ' + m + ' 分';
	return m + ' 分 ' + Math.floor(sec % 60) + ' 秒';
}

function smoothPath(ctx, pts) {
	var i;

	ctx.moveTo(pts[0][0], pts[0][1]);

	for (i = 1; i < pts.length; i++) {
		var mx = (pts[i - 1][0] + pts[i][0]) / 2,
		    my = (pts[i - 1][1] + pts[i][1]) / 2;

		ctx.quadraticCurveTo(pts[i - 1][0], pts[i - 1][1], mx, my);
	}

	ctx.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
}

/*
 * 时间轴绘制：每个点的横坐标由「当前时刻 - 采样时刻」直接算出，
 * 所以曲线每秒固定左移一格，与采样请求早到晚到完全无关，永不冻结、永不跳格。
 */
function drawSeries(ctx, rect, series, style, max, now, tip) {
	if (!series || !series.length)
		return;

	if (max <= 0) max = 1;

	var step = rect.w / (HIST - 1),
	    sp = step / POLL_MS,
	    pts = [],
	    i, x, v;

	for (i = 0; i < series.length; i++) {
		x = rect.x + rect.w - (now - series[i].t) * sp;

		if (x < rect.x - step * 2)
			continue;

		v = (i === series.length - 1 && tip !== undefined) ? tip : series[i].v;

		pts.push([ x, rect.y + rect.h - (Math.min(Math.max(v, 0), max) / max) * (rect.h - 6) - 3 ]);
	}

	if (!pts.length)
		return;

	pts[0][0] = Math.max(pts[0][0], rect.x);

	/* 右端按最新值平推补满：下一次采样还没到时也不留缺口，来数据后无跳变 */
	pts.push([ rect.x + rect.w, pts[pts.length - 1][1] ]);

	var g = ctx.createLinearGradient(0, rect.y, 0, rect.y + rect.h);

	g.addColorStop(0, style.fillTop);
	g.addColorStop(1, style.fillBottom);

	ctx.beginPath();
	smoothPath(ctx, pts);
	ctx.lineTo(rect.x + rect.w, rect.y + rect.h);
	ctx.lineTo(pts[0][0], rect.y + rect.h);
	ctx.lineTo(pts[0][0], pts[0][1]);
	ctx.closePath();
	ctx.fillStyle = g;
	ctx.fill();

	ctx.beginPath();
	smoothPath(ctx, pts);
	ctx.strokeStyle = style.stroke;
	ctx.lineWidth = 1.6;
	ctx.stroke();
}

/* 画布底层像素跟随显示尺寸 × DPR，避免逻辑坐标被放大导致文字发虚 */
function fitLayer(cv, lw, lh) {
	var ctx = cv.getContext('2d'),
	    dpr = Math.min((typeof window !== 'undefined' && window.devicePixelRatio) || 1, 2),
	    cssW = cv.clientWidth || 0,
	    cssH = cv.clientHeight || 0,
	    bw, bh;

	if (cssW > 0 && cssH > 0) {
		bw = Math.round(cssW * dpr);
		bh = Math.round(cssH * dpr);

		if (cv.width !== bw || cv.height !== bh) {
			cv.width = bw;
			cv.height = bh;
		}
	}

	bw = cv.width;
	bh = cv.height;

	if (ctx.setTransform)
		ctx.setTransform(bw / lw, 0, 0, bh / lh, 0, 0);

	return ctx;
}

function drawMini(cv, series, style, max, now, tip) {
	var ctx = fitLayer(cv, MINI_W, MINI_H);

	ctx.clearRect(0, 0, MINI_W, MINI_H);
	drawSeries(ctx, { x: 1, y: 4, w: MINI_W - 2, h: MINI_H - 8 }, series, style, max, now, tip);
}

/* 坐标轴层：只保留 5 条横向网格线（刻度文字已按要求去掉，避免小字发虚） */
function drawNetGrid(cv, max, now, series) {
	var ctx
 = fitLayer(cv, NET_W, NET_H),
	    W = NET_W,
	    H = NET_H,
	    rect = { x: PAD.l, y: PAD.t, w: W - PAD.l - PAD.r, h: H - PAD.t - PAD.b },
	    i, y;

	ctx.clearRect(0, 0, W, H);

	ctx.lineWidth = 1;
	ctx.strokeStyle = 'rgba(0,0,0,.07)';

	for (i = 0; i <= 4; i++) {
		y = rect.y + rect.h * i / 4;

		ctx.beginPath();
		ctx.moveTo(rect.x, y + .5);
		ctx.lineTo(rect.x + rect.w, y + .5);
		ctx.stroke();
	}
}

/* 动画层：只有两条面积曲线，背景透明 */
function drawNetCurve(cv, rx, tx, max, now, dl, ul) {
	var ctx = fitLayer(cv, NET_W, NET_H),
	    rect = { x: PAD.l, y: PAD.t, w: NET_W - PAD.l - PAD.r, h: NET_H - PAD.t - PAD.b };

	ctx.clearRect(0, 0, NET_W, NET_H);

	drawSeries(ctx, rect, rx, { stroke: '#2f7ef7', fillTop: 'rgba(47,126,247,.30)', fillBottom: 'rgba(47,126,247,.02)' }, max, now, dl);
	drawSeries(ctx, rect, tx, { stroke: '#10a374', fillTop: 'rgba(16,163,116,.22)', fillBottom: 'rgba(16,163,116,.02)' }, max, now, ul);
}

function drawRingLabel(ctx, cx, cy, r, a0, a1, text) {
	var a = (a0 + a1) / 2,
	    cos = Math.cos(a), sin = Math.sin(a),
	    right = cos >= 0,
	    x1 = cx + r * cos, y1 = cy + r * sin,
	    x2 = cx + (r + 12) * cos, y2 = cy + (r + 12) * sin,
	    x3 = x2 + (right ? 8 : -8);

	ctx.strokeStyle = 'rgba(0,0,0,.28)';
	ctx.lineWidth = 1;
	ctx.beginPath();
	ctx.moveTo(x1, y1);
	ctx.lineTo(x2, y2);
	ctx.lineTo(x3, y2);
	ctx.stroke();

	ctx.fillStyle = 'rgba(0,0,0,.66)';
	ctx.font = '14px ui-sans-serif,system-ui,sans-serif';
	ctx.textAlign = right ? 'left' : 'right';
	ctx.textBaseline = 'middle';
	ctx.fillText(text, x3 + (right ? 3 : -3), y2);
}

function drawDonut(cv, segs) {
	var ctx = fitLayer(cv, 320, 320),
	    W = 320,
	    H = 320;

	ctx.clearRect(0, 0, W, H);

	var total = segs.reduce(function(a, s) { return a + s.v; }, 0);

	if (total <= 0)
		return;

	var cx = W / 2,
	    cy = H / 2,
	    r = Math.min(W, H) / 2 - 56,
	    r0 = r * 0.64,
	    a0 = -Math.PI / 2;

	segs.forEach(function(s) {
		var a1 = a0 + s.v / total * Math.PI * 2;

		ctx.beginPath();
		ctx.arc(cx, cy, r, a0, Math.max(a1, a0 + 0.0001));
		ctx.arc(cx, cy, r0, Math.max(a1, a0 + 0.0001), a0, true);
		ctx.closePath();
		ctx.fillStyle = s.c;
		ctx.fill();

		if (s.name && s.v / total >= 0.015)
			drawRingLabel(ctx, cx, cy, r, a0, a1, s.name);

		a0 = a1;
	});
}

function drawStack(cv, segs) {
	var ctx = cv.getContext('2d'),
	    W = cv.width,
	    H = cv.height;

	ctx.clearRect(0, 0, W, H);

	var total = segs.reduce(function(a, s) { return a + s.v; }, 0) || 1,
	    x = 0;

	segs.forEach(function(s) {
		var w = s.v / total * W;

		ctx.fillStyle = s.c;
		ctx.fillRect(x, 0, Math.max(w, 2), H);
		x += w;
	});
}

/* /proc/cpuinfo：system type / cpu model / BogoMIPS，用于显示 CPU 型号与架构 */
function parseCpuInfo(txt) {
	var o = {};

	(txt || '').split('\n').forEach(function(l) {
		var m = l.match(/^([A-Za-z ]+?)\s*:\s*(.+)$/);

		if (m && !o[m[1].trim().toLowerCase()])
			o[m[1].trim().toLowerCase()] = m[2].trim();
	});

	return {
		system: o['system type'] || o['hardware'] || '',
		model: o['cpu model'] || o['model name'] || '',
		bogo: Number(o['bogomips']) || 0,
		mhz: Number(o['cpu mhz']) || 0
	};
}

/* SHORTCUTS:BEGIN */
var SHORTCUTS = [
	{ t: '网络设置', p: 'admin/network/network',           c: '#2f7ef7', bg: 'rgba(47,126,247,.06)',
	  i: '<rect x="3" y="4.5" width="18" height="5" rx="1.6"/><rect x="3" y="13.5" width="18" height="5" rx="1.6"/><path d="M6.8 7h.01M6.8 16h.01"/>' },
	{ t: '无线设置', p: 'admin/network/wireless',          c: '#10a374', bg: 'rgba(16,163,116,.06)',
	  i: '<path d="M3.5 8.5a12 12 0 0 1 17 0"/><path d="M6.8 12.2a7.5 7.5 0 0 1 10.4 0"/><path d="M10 15.9a3 3 0 0 1 4 0"/><circle cx="12" cy="19" r="1"/>' },
	{ t: 'DHCP/DNS', p: 'admin/network/dhcp',              c: '#7c5cf0', bg: 'rgba(124,92,240,.06)',
	  i: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5c2.4 2.6 2.4 14.4 0 17"/><path d="M12 3.5c-2.4 2.6-2.4 14.4 0 17"/>' },
	{ t: '固件升级', p: 'admin/system/flash',              c: '#0f9bd7', bg: 'rgba(15,155,215,.06)',
	  i: '<path d="M12 4v9"/><path d="M8.5 10.5 12 14l3.5-3.5"/><path d="M5 17.5h14"/>' },
	{ t: '重启设备', p: 'admin/system/reboot',             c: '#e0508b', bg: 'rgba(224,80,139,.06)',
	  i: '<path d="M20 12a8 8 0 1 1-3.2-6.4"/><path d="M20 4.5V9h-4.5"/>' },
	{ t: '系统日志', p: 'admin/status/logs',               c: '#e5533d', bg: 'rgba(229,83,61,.06)',
	  i: '<path d="M6.5 3.5h7l4 4v13h-11z"/><path d="M13.5 3.5v4h4"/><path d="M9 12h6M9 15.5h6"/>' },
	{ t: '实时流量', p: 'admin/status/realtime/bandwidth', c: '#c47f17', bg: 'rgba(196,127,23,.06)',
	  i: '<path d="M3 14l3.5-4 3 2.5 3.5-5.5 3 4 3.5-3"/><path d="M3 19h18"/>' },
	{ t: '终端',     p: 'admin/system/ttyd/ttyd',          c: '#4257c9', bg: 'rgba(66,87,201,.06)',
	  i: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M6.5 9.5 9.5 12l-3 2.5"/><path d="M11.5 15h5"/>' }
];
/* SHORTCUTS:END */

return view.extend({
	parseCpu: parseCpu,
	cpuPercent: cpuPercent,
	parseMem: parseMem,
	parseNet: parseNet,
	parseMtd: parseMtd,
	parseUptime: parseUptime,
	parseLoad: parseLoad,
	parseKernel: parseKernel,
	cpuCores: cpuCores,
	parseRelease: parseRelease,
	parseLeases: parseLeases,
	parseArp: parseArp,
	parseWireless: parseWireless,
	wlanIfaces: wlanIfaces,
	mergeClients: mergeClients,
	devLabel: devLabel,
	smooth: smoothPath,

	load: function() {
		return Promise.resolve(null);
	},

	render: function() {
		var cpuHist = [], memHist = [], rxHist = [], txHist = [],
		    prevCpu = null, prevNet = null, prevT = 0,
		    statLoaded = false, slowTick = 0, last = {}, refs = {},
		    KEYS = [ 'cpu', 'memUsed', 'memCache', 'memFree', 'memTotal', 'dl', 'ul' ],
		    target = { cpu: 0, memUsed: 0, memCache: 0, memFree: 0, memTotal: 0, dl: 0, ul: 0 },
		    shown = { cpu: 0, memUsed: 0, memCache: 0, memFree: 0, memTotal: 0, dl: 0, ul: 0 },
		    emaCpu = null, emaDl = null, emaUl = null,
		    cpuAvg = null, cpu3 = [],
		    netMax = 0, netName = '', cores = 0, clients = [],
		    mtdTotal = 0, mtdParts = [], flashStat = { used: 0, free: 0, total: 0 },
		    netInfo = { lan: '—', wan: '—', gw: '—', dns: '—' }, portList = [], switchPorts = { wan: 1, lan: 1 },
		    radios = [], wifiMac = {}, last = { netDev: '' },
		    started = 0, prevFrame = 0, lastText = 0, lastDraw = 0, lastGrid = 0,
		    pollId = 0, stopped = false, donutKey = '';

		var css = [
			'.home{ font-size:13px; }',
			'.home-grid{ display:grid; gap:12px; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); }',
			'.home-card{ border:1px solid rgba(0,0,0,.08); border-radius:10px; padding:12px 14px; }',
			'.home-card h4{ margin:0 0 8px; font-size:12px; font-weight:600; opacity:.62; letter-spacing:.4px; }',
			'.home-big{ font-size:25px; font-weight:700; line-height:1.25; font-variant-numeric:tabular-nums; }',
			'.home-sub{ font-size:12px; opacity:.6; margin-bottom:8px; }',
			'.home-cv{ display:block; width:100%; border-radius:6px; }',
			'.home-shot{ position:relative; height:190px; }',
			'.home-shot canvas{ position:absolute; left:0; top:0; width:100%; height:190px; display:block; pointer-events:none; }',
			'.home-wide{ display:grid; gap:12px; grid-template-columns:minmax(0,2fr) minmax(0,1fr); margin-top:12px; }',
			'.home-main{ display:grid; gap:12px; grid-template-columns:minmax(0,1.3fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1.25fr); margin-top:12px; }',
			'.home-stack{ display:grid; gap:12px; grid-template-rows:1fr 1fr; }',
			'.home-stack .home-card{ display:flex; flex-direction:column; }',
			'.home-stack .port-box{ flex:1; align-content:center; justify-content:center; }',
			'.net-rows{ display:grid; gap:7px; font-size:12px; }',
			'.net-rows .row{ display:flex; justify-content:space-between; gap:10px; }',
			'.net-rows span{ opacity:.58; }',
			'.net-rows b{ font-weight:600; font-variant-numeric:tabular-nums; text-align:right; font-family:ui-monospace,Consolas,monospace; }',
			'.port-box{ display:flex; gap:8px; flex-wrap:wrap; margin-top:10px; }',
			'.port-tile{ flex:1; min-width:62px; border:1px solid rgba(0,0,0,.08); border-radius:8px; padding:8px 6px; text-align:center; }',
			'.port-tile .p-icon{ line-height:0; margin-bottom:6px; }',
			'.port-tile .p-name{ font-size:11px; opacity:.7; margin-bottom:2px; }',
			'.port-tile .p-state{ font-size:11px; font-weight:600; font-variant-numeric:tabular-nums; }',
			'.port-tile .p-speed{ font-size:10px; opacity:.55; margin-top:1px; }',
			'.port-tile.up .p-state{ color:#10a374; }',
			'.port-tile.down .p-state{ opacity:.5; }',
			'.home-main > .home-card{ display:flex; flex-direction:column; }',
			'.home-wifi{ display:grid; gap:10px; grid-template-columns:1fr 1fr; flex:1; min-height:0; }',
			'.wifi-radio{ min-height:0; display:flex; flex-direction:column; border:1px solid rgba(0,0,0,.08); border-radius:10px; padding:11px 12px; }',
			'.wifi-radio .wifi-rows{ flex:1; }',
			'.wifi-top{ display:flex; align-items:center; gap:8px; margin-bottom:8px; }',
			'.wifi-badge{ font-size:11px; font-weight:600; padding:2px 8px; border-radius:6px; background:rgba(47,126,247,.1); color:#2f7ef7; }',
			'.wifi-dot{ width:7px; height:7px; border-radius:50%; background:#10a374; display:inline-block; }',
			'.wifi-dot.off{ background:#c0c6cf; }',
			'.wifi-state{ font-size:11px; opacity:.6; margin-left:auto; }',
			'.wifi-edit{ font-size:11px; line-height:1; padding:4px 9px; border-radius:6px; border:1px solid rgba(47,126,247,.35); color:#2f7ef7; text-decoration:none; white-space:nowrap; }',
			'.wifi-edit:hover{ background:rgba(47,126,247,.08); }',
			'.wifi-ssid{ font-size:14px; font-weight:600; margin-bottom:8px; }',
			'.wifi-rows{ display:grid; gap:6px; font-size:12px; }',
			'.wifi-rows .row{ display:flex; justify-content:space-between; gap:10px; }',
			'.wifi-rows span{ opacity:.58; }',
			'.wifi-rows b{ font-weight:600; font-variant-numeric:tabular-nums; text-align:right; }',
			'.wifi-rows .mac{ font-family:ui-monospace,Consolas,monospace; letter-spacing:.2px; }',
			'.home-rate{ display:grid; gap:10px; grid-template-columns:1fr 1fr; }',
			'.home-rate .lb{ font-size:12px; opacity:.62; margin-bottom:2px; }',
			'.home-legend{ display:flex; gap:14px; flex-wrap:wrap; font-size:12px; margin-top:8px; }',
			'.home-legend.center{ justify-content:center; gap:22px; }',
			'.home-legend i{ display:inline-block; width:9px; height:9px; border-radius:2px; margin-right:5px; vertical-align:middle; }',
			'.home-info{ display:grid; gap:10px; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); font-size:12px; }',
			'.home-info span{ display:block; opacity:.58; margin-bottom:3px; }',
			'.home-info b{ font-weight:600; font-variant-numeric:tabular-nums; }',
			'.home-devs{ margin-top:12px; }',
			'.home-dev{ width:100%; border-collapse:collapse; font-size:12px; }',
			'.home-dev th{ text-align:left; opacity:.58; font-weight:600; padding:6px 8px; border-bottom:1px solid rgba(0,0,0,.08); }',
			'.home-dev td{ padding:7px 8px; border-bottom:1px solid rgba(0,0,0,.05); font-variant-numeric:tabular-nums; }',
			'.home-dev tr:last-child td{ border-bottom:none; }',
			'.home-dev .mac{ font-family:ui-monospace,Consolas,monospace; letter-spacing:.2px; }',
			'.home-empty{ opacity:.55; padding:16px 8px; text-align:center; }',
			'.home-head{ display:flex; align-items:center; justify-content:space-between; margin-bottom:8px; }',
			'.home-head h4{ margin:0; }',
			'.home-head .val{ font-size:12px; opacity:.72; font-variant-numeric:tabular-nums; }',
			'.home-donut{ margin:0 auto; width:100%; max-width:220px; height:220px; }',
			/* SHORTCUTS:BEGIN */
			'.home-quick{ display:grid; gap:10px; grid-template-columns:repeat(8,minmax(0,1fr)); margin-bottom:12px; }',
			'.home-quick a{ display:flex; flex-direction:column; align-items:center; justify-content:center; gap:7px;',
			'  padding:13px 4px; border-radius:10px; border:1px solid rgba(0,0,0,.07); text-decoration:none;',
			'  color:inherit; transition:transform .15s, box-shadow .15s, border-color .15s; }',
			'.home-quick a:hover{ transform:translateY(-1px); border-color:rgba(47,126,247,.4);',
			'  box-shadow:0 5px 16px rgba(47,126,247,.14); }',
			'.home-quick .ico{ line-height:0; }',
			'.home-quick span{ font-size:12px; white-space:nowrap; }',
			'@media (max-width:1100px){ .home-quick{ grid-template-columns:repeat(4,minmax(0,1fr)); } }',
			/* SHORTCUTS:END */
			'@media (max-width:1100px){ .home-wifi{ grid-template-columns:minmax(0,1fr); } }',
			'@media (max-width:820px){ .home-wide, .home-main, .home-wifi{ grid-template-columns:minmax(0,1fr); } }'
		].join('\n');

		var cvCpu = E('canvas', { class: 'home-cv', width: MINI_W, height: MINI_H, style: 'height:52px' }),
		    cvMem = E('canvas', { class: 'home-cv', width: MINI_W, height: MINI_H, style: 'height:52px' }),
		    cvNet = E('canvas', { width: NET_W, height: NET_H }),
		    cvGrid = E('canvas', { width: NET_W, height: NET_H }),
		    cvDonut = E('canvas', { class: 'home-cv home-donut', width: 320, height: 320 }),
		    cvFlashDonut = E('canvas', { class: 'home-cv home-donut', width: 320, height: 320 });

		refs.netShot = E('div', { class: 'home-shot' }, [ cvNet, cvGrid ]);

		refs.cpuVal = E('div', { class: 'home-big' }, '—');
		refs.cpuSub = E('div', { class: 'home-sub' }, '采样中…');
		refs.memVal = E('div', { class: 'home-big' }, '—');
		refs.memSub = E('div', { class: 'home-sub' }, '采样中…');
		refs.dlVal = E('div', { class: 'home-big' }, '—');
		refs.ulVal = E('div', { class: 'home-big' }, '—');
		refs.netSub = E('div', { class: 'home-sub', style: 'margin-top:6px;margin-bottom:0' }, '—');
		refs.netHead = E('div', { class: 'val' }, '—');
		refs.upVal = E('div', { class: 'home-big' }, '—');
		refs.upSub = E('div', { class: 'home-sub' }, '—');
		refs.flashVal = E('div', { class: 'home-big' }, '—');
		refs.flashSub = E('div', { class: 'home-sub' }, '—');
		refs.donutLegend = E('div', { class: 'home-legend' });
		refs.flashLegend = E('div', { class: 'home-legend' });
		refs.info = E('div', { class: 'home-info' });
		refs.netInfo = E('div', { class: 'net-rows' });
		refs.portHead = E('div', { class: 'val' }, '—');
		refs.portBox = E('div', { class: 'port-box' });

		/* SHORTCUTS:BEGIN */
		var quick = E('div', { class: 'home-quick' }, SHORTCUTS.map(function(s) {
			var link = (typeof L !== 'undefined' && L.url) ? L.url(s.p) : ('/cgi-bin/luci/' + s.p),
			    ico = E('div', { class: 'ico' });

			ico.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="' + s.c +
				'" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' + s.i + '</svg>';

			return E('a', { href: link, style: 'background:' + s.bg }, [ ico, E('span', {}, s.t) ]);
		}));
		/* SHORTCUTS:END */
		refs.devHead = E('div', { class: 'val' }, '—');
		refs.devTable = E('div', {});
		refs.wifiHead = E('div', { class: 'val' }, '—');
		refs.wifi = E('div', { class: 'home-wifi' });

		var root = E('div', { class: 'home' }, [
			E('style', {}, css),
			E('h2', {}, PAGE_TITLE),
			quick,
			E('div', { class: 'home-grid' }, [
				E('div', { class: 'home-card' }, [ E('h4', {}, 'CPU 使用率'), refs.cpuVal, refs.cpuSub, cvCpu ]),
			E('div', { class: 'home-card' }, [ E('h4', {}, '内存使用率'), refs.memVal, refs.memSub, cvMem ]),
			E('div', { class: 'home-card' }, [
				E('h4', {}, '实时速率'),
				E('div', { class: 'home-rate' }, [
					E('div', {}, [ E('div', { class: 'lb' }, '↓ 下载'), refs.dlVal ]),
					E('div', {}, [ E('div', { class: 'lb' }, '↑ 上传'), refs.ulVal ])
				]),
				refs.netSub
			]),
				E('div', { class: 'home-card' }, [ E('h4', {}, '运行时间 / 负载'), refs.upVal, refs.upSub ])
			]),
			E('div', { class: 'home-wide' }, [
				E('div', { class: 'home-card' }, [
					E('div', { class: 'home-head' }, [ E('h4', {}, '网络速度'), refs.netHead ]),
					refs.netShot,
					E('div', { class: 'home-legend center' }, [
						E('span', {}, [ E('i', { style: 'background:#2f7ef7' }), '下载' ]),
						E('span', {}, [ E('i', { style: 'background:#10a374' }), '上传' ])
					])
				]),
				E('div', { class: 'home-card' }, [
					E('h4', {}, '内存构成'),
					cvDonut,
					refs.donutLegend
				])
			]),
			E('div', { class: 'home-main' }, [
				E('div', { class: 'home-card' }, [
					E('h4', {}, 'Flash 存储'),
					refs.flashVal,
					refs.flashSub,
					cvFlashDonut,
					refs.flashLegend
				]),
				E('div', { class: 'home-card' }, [
					E('h4', {}, '设备信息'),
					refs.info
				]),
				E('div', { class: 'home-stack' }, [
					E('div', { class: 'home-card' }, [
						E('h4', {}, '网络'),
						refs.netInfo
					]),
					E('div', { class: 'home-card' }, [
						E('div', { class: 'home-head' }, [ E('h4', {}, '网口状态'), refs.portHead ]),
						refs.portBox
					])
				]),
				E('div', { class: 'home-card' }, [
					E('div', { class: 'home-head' }, [ E('h4', {}, '无线网络'), refs.wifiHead ]),
					refs.wifi
				])
			]),
			E('div', { class: 'home-card home-devs' }, [
				E('div', { class: 'home-head' }, [ E('h4', {}, '局域网设备'), refs.devHead ]),
				refs.devTable
			])
		]);

		var safe = function(p) {
			return p.catch(function() { return ''; });
		};

		var renderFlash = function() {
			if (mtdTotal <= 0) return;
			refs.flashVal.textContent = flashStat.used > 0 ? bytes(flashStat.used) : '—';
			refs.flashSub.textContent = '共 ' + mib(mtdTotal) + (flashStat.free > 0 ? ' · 可用 ' + bytes(flashStat.free) : '');

			var reservedColors = [ '#2f7ef7', '#f0b429', '#7c5cf0' ],
				segs = [], ri = 0;

			(mtdParts || []).forEach(function(p) {
				if (!p.nested && p.name !== 'firmware')
					segs.push({ name: p.name, v: p.size, c: reservedColors[ri++ % reservedColors.length] });
			});
			segs.push({ name: '固件占用', v: flashStat.used, c: '#10a374' });
			segs.push({ name: '剩余可用', v: flashStat.free, c: 'rgba(128,128,128,.35)' });

			drawDonut(cvFlashDonut, segs.map(function(s) { return { v: s.v, c: s.c, name: s.name }; }));

			refs.flashLegend.textContent = '';
			segs.forEach(function(s) {
				refs.flashLegend.appendChild(E('span', {}, [
					E('i', { style: 'background:' + s.c }), s.name + ' ' + bytes(s.v)
				]));
			});
		};

		var push = function(arr, v, t, wall) {
			arr.push({ t: t, v: v, w: wall });

			while (arr.length > HIST)
				arr.shift();
		};

		var frame = function(fn) {
			if (typeof requestAnimationFrame === 'function') requestAnimationFrame(fn);
			else setTimeout(function() { fn(Date.now()); }, 16);
		};

		var clock = function() {
			return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
		};

		var BLUE = { stroke: '#2f7ef7', fillTop: 'rgba(47,126,247,.30)', fillBottom: 'rgba(47,126,247,.02)' },
		    PURPLE = { stroke: '#7c5cf0', fillTop: 'rgba(124,92,240,.28)', fillBottom: 'rgba(124,92,240,.02)' };

		var paintText = function() {
			var memPct = target.memTotal > 0 ? target.memUsed / target.memTotal * 100 : 0,
			    tCpu = (cpuAvg === null ? target.cpu : cpuAvg).toFixed(1) + ' %',
			    tMem = memPct.toFixed(1) + ' %',
			    tDl = rate(target.dl * 1024),
			    tUl = rate(target.ul * 1024),
			    tIf = (netName ? '接口 ' + netName : '—') + ' · 每秒采样 · 平滑刷新 v5.3',
			    tCpuSub = cores + ' 核 · 平滑刷新 v5.3',
			    tMemSub = bytes(target.memUsed) + ' / ' + bytes(target.memTotal),
			    tHead = '下载 ' + shortRate(target.dl) + ' ／ 上传 ' + shortRate(target.ul);

			if (refs.cpuVal.textContent !== tCpu) refs.cpuVal.textContent = tCpu;
			if (refs.memVal.textContent !== tMem) refs.memVal.textContent = tMem;
			if (refs.dlVal.textContent !== tDl) refs.dlVal.textContent = tDl;
			if (refs.ulVal.textContent !== tUl) refs.ulVal.textContent = tUl;
			if (refs.netSub.textContent !== tIf) refs.netSub.textContent = tIf;
			if (refs.cpuSub.textContent !== tCpuSub) refs.cpuSub.textContent = tCpuSub;
			if (refs.memSub.textContent !== tMemSub) refs.memSub.textContent = tMemSub;
			if (refs.netHead.textContent !== tHead) refs.netHead.textContent = tHead;
		};

		paintText();

		var renderClients = function() {
			refs.devHead.textContent = clients.length ? '在线 ' + clients.length + ' 台' : '暂无设备';
			refs.devTable.textContent = '';

			if (!clients.length) {
				refs.devTable.appendChild(E('div', { class: 'home-empty' }, '暂无在线设备（等待 DHCP / ARP 记录）'));
				return;
			}

			var tbl = E('table', { class: 'home-dev' }, [
				E('thead', {}, E('tr', {}, [
					E('th', {}, '主机名'), E('th', {}, 'IP 地址'), E('th', {}, 'MAC 地址'), E('th', {}, '连接')
				]))
			]);
			var tbody = E('tbody', {});

			clients.forEach(function(c) {
				tbody.appendChild(E('tr', {}, [
					E('td', {}, c.host || '—'),
					E('td', {}, c.ip),
					E('td', { class: 'mac' }, c.mac),
					E('td', {}, devLabel(c.dev))
				]));
			});

			tbl.appendChild(tbody);
			refs.devTable.appendChild(tbl);
		};

		renderClients();

		var renderWireless = function() {
			refs.wifi.textContent = '';

			if (!radios.length) {
				refs.wifiHead.textContent = '—';
				refs.wifi.appendChild(E('div', { class: 'home-empty' }, '未检测到无线配置'));
				return;
			}

			var wlans = wlanIfaces(last.netDev),
			    on = radios.filter(function(r) { return !r.disabled; }).length,
			    editUrl = (typeof L !== 'undefined' && L.url) ? L.url('admin/network/wireless') : '/cgi-bin/luci/admin/network/wireless';

			refs.wifiHead.textContent = on + ' / ' + radios.length + ' 启用';

			radios.forEach(function(rd, i) {
				rd.ifname = wlans[i] || rd.ifname;

				var count = clients.filter(function(c) { return c.dev === rd.ifname; }).length,
				    mac = wifiMac[rd.ifname] || '—',
				    rows = [
						[ '信道', 'Ch ' + (rd.channel || '—') + (rd.freq ? ' · ' + rd.freq + ' MHz' : '') ],
						[ '模式', modeLabel(rd.mode) ],
						[ '带宽', widthLabel(rd.htmode) ],
						[ '加密', encLabel(rd.encryption) ],
						[ 'BSSID', mac ],
						[ '关联', count + ' 台' ]
					],
				    rowsEl = E('div', { class: 'wifi-rows' });

				rows.forEach(function(r) {
					rowsEl.appendChild(E('div', { class: 'row' }, [
						E('span', {}, r[0]),
						E('b', { class: r[0] === 'BSSID' ? 'mac' : '' }, r[1])
					]));
				});

				refs.wifi.appendChild(E('div', { class: 'wifi-radio' }, [
					E('div', { class: 'wifi-top' }, [
						E('span', { class: 'wifi-badge' }, bandLabel(rd.band)),
						E('span', { class: 'wifi-dot' + (rd.disabled ? ' off' : '') }),
						E('span', { class: 'wifi-state' }, rd.disabled ? '关闭' : '启用'),
						E('a', { class: 'wifi-edit', href: editUrl, title: '编辑 ' + (rd.ssid || bandLabel(rd.band)) }, '编辑')
					]),
					E('div', { class: 'wifi-ssid' }, rd.ssid || '—'),
					rowsEl
				]));
			});
		};

		renderWireless();

		var renderNet = function() {
			refs.netInfo.textContent = '';
			[ [ 'LAN', netInfo.lan ], [ 'WAN', netInfo.wan ], [ '网关', netInfo.gw ], [ 'DNS', netInfo.dns ] ].forEach(function(x) {
				refs.netInfo.appendChild(E('div', { class: 'row' }, [
					E('span', {}, x[0]), E('b', {}, x[1])
				]));
			});

			refs.portBox.textContent = '';
			var wanN = portList.filter(function(p) { return p.role === 'WAN'; }).length,
				lanN = portList.length - wanN;
			refs.portHead.textContent = portList.length ? ('WAN ' + wanN + ' · LAN ' + lanN) : '—';

			if (!portList.length) {
				refs.portBox.appendChild(E('div', { class: 'home-empty' }, '未检测到有线网口'));
				return;
			}

			portList.forEach(function(p) {
				var ico = E('div', { class: 'p-icon' });
				ico.innerHTML = portIcon(p.carrier);
				refs.portBox.appendChild(E('div', { class: 'port-tile ' + (p.carrier ? 'up' : 'down') }, [
					ico,
					E('div', { class: 'p-name' }, p.name),
					E('div', { class: 'p-state' }, p.carrier ? '在用' : '空闲'),
					E('div', { class: 'p-speed' }, p.carrier ? speedText(p) : '无链路')
				]));
			});
		};

		var poll = function() {
			var t = clock(),
			    slow = (slowTick++ % 5) === 0;

			Promise.all([
				safe(fs.read('/proc/stat')),
				safe(fs.read('/proc/meminfo')),
				safe(fs.read('/proc/net/dev')),
				slow ? safe(fs.read('/proc/uptime')) : Promise.resolve(null),
				slow ? safe(fs.read('/proc/loadavg')) : Promise.resolve(null),
				statLoaded ? Promise.resolve(null) : safe(fs.read('/proc/mtd')),
				statLoaded ? Promise.resolve(null) : safe(fs.read('/proc/version')),
				statLoaded ? Promise.resolve(null) : safe(fs.read('/proc/device-tree/model')),
				statLoaded ? Promise.resolve(null) : safe(fs.read('/proc/cpuinfo')),
				statLoaded ? Promise.resolve(null) : safe(fs.read('/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq')),
				slow ? safe(fs.read('/tmp/dhcp.leases')) : Promise.resolve(null),
				slow ? safe(fs.read('/proc/net/arp')) : Promise.resolve(null),
				statLoaded ? Promise.resolve(null) : safe(fs.read('/etc/openwrt_release')),
				slow ? safe(fs.read('/etc/config/wireless')) : Promise.resolve(null),
				slow ? safe(callSystemInfo()) : Promise.resolve(null),
				slow ? safe(callNetDump()) : Promise.resolve(null),
				slow ? safe(callNetDevs()) : Promise.resolve(null),
				slow ? safe(fs.read('/etc/config/network')) : Promise.resolve(null)
			]).then(function(r) {
				var cpu = parseCpu(r[0]),
				    pct = cpuPercent(prevCpu, cpu);

				if (pct !== null) {
					emaCpu = (emaCpu === null) ? pct : (emaCpu * 0.45 + pct * 0.55);
					target.cpu = emaCpu;

					/* 显示用：最近 3 次采样的滑动平均，压住单核每跳 6%↔100% 的抖动 */
					cpu3.push(pct);
					if (cpu3.length > 3) cpu3.shift();
					var sum3 = 0;
					for (var q = 0; q < cpu3.length; q++) sum3 += cpu3[q];
					cpuAvg = sum3 / cpu3.length;
					push(cpuHist, emaCpu, t, Date.now());
				}

				prevCpu = cpu;
				cores = cpuCores(r[0]) || cores;

				var mem = parseMem(r[1]);

				if (mem) {
					target.memUsed = mem.used;
					target.memCache = mem.cache;
					target.memFree = mem.free;
					target.memTotal = mem.total;
					push(memHist, mem.used / mem.total * 100, t, Date.now());
				}

				var net = parseNet(r[2]);

				if (net && prevNet && prevT) {
					var dt = (t - prevT) / 1000;

					if (dt > 0.2) {
						var dl = Math.max(0, (net.rx - prevNet.rx) / dt) / 1024,
						    ul = Math.max(0, (net.tx - prevNet.tx) / dt) / 1024;

						emaDl = (emaDl === null) ? dl : (emaDl * 0.45 + dl * 0.55);
						emaUl = (emaUl === null) ? ul : (emaUl * 0.45 + ul * 0.55);

						target.dl = emaDl;
						target.ul = emaUl;
						push(rxHist, emaDl, t, Date.now());
						push(txHist, emaUl, t, Date.now());
						netName = net.name;
					}
				}

				prevNet = net;
				prevT = t;

				last.netDev = r[2];

				if (slow) {
					if (r[14] && r[14].root) {
						var sroot = r[14].root;
						flashStat.total = (Number(sroot.total) || 0) * 1024;
						flashStat.used = (Number(sroot.used) || 0) * 1024;
						flashStat.free = (Number(sroot.free) != null ? Number(sroot.free) : (Number(sroot.total) - Number(sroot.used))) * 1024;
						renderFlash();
					}

					refs.upVal.textContent = uptimeText(parseUptime(r[3]));
					refs.upSub.textContent = '负载 ' + parseLoad(r[4]).map(function(x) {
						return x.toFixed(2);
					}).join(' / ');

					clients = mergeClients(parseArp(r[11]), parseLeases(r[10]));
					renderClients();

					radios = parseWireless(r[13]);
					var wlans = wlanIfaces(r[2]);

					radios.forEach(function(rd, i) {
						rd.ifname = wlans[i] || rd.ifname;
					});

					renderWireless();

					var rawDump = r[15],
					dump = Array.isArray(rawDump) ? rawDump : (rawDump && Array.isArray(rawDump.interface) ? rawDump.interface : []),
						byName = {};
					dump.forEach(function(i) { if (i && i.interface) byName[i.interface] = i; });

					var lanIf = byName.lan, wanIf = byName.wan;
					netInfo.lan = ifcCidr(lanIf) || '—';
					netInfo.wan = ifcCidr(wanIf) || (wanIf && wanIf.up ? '已连接' : '未连接');
					netInfo.gw = ifcGw(wanIf) || ifcGw(lanIf) || '—';
					netInfo.dns = ifcDns(wanIf).concat(ifcDns(lanIf))
						.filter(function(v, i, a) { return a.indexOf(v) === i; })
						.join(' / ') || '—';

					var sw = parseSwitchPorts(r[17]);
					switchPorts.wan = sw.wan || 1;
					switchPorts.lan = sw.lan || 1;

					var devs = (r[16] && typeof r[16] === 'object') ? r[16] : {};
					portList = pickPorts(devs, wanIf && wanIf.l3_device, lanIf && lanIf.l3_device, switchPorts.wan, switchPorts.lan);
					renderNet();

					Promise.all(radios.map(function(rd) {
						return rd.ifname ? safe(fs.read('/sys/class/net/' + rd.ifname + '/address')) : Promise.resolve('');
					})).then(function(macs) {
						radios.forEach(function(rd, i) {
							wifiMac[rd.ifname] = (macs[i] || '').trim().toLowerCase();
						});
						renderWireless();
					});
				}

				if (rxHist.length) {
					var top = Math.max.apply(null, rxHist.concat(txHist).map(function(p) { return p.v; }).concat([ 10 ])) * 1.06;

					netMax = netMax ? Math.max(top, netMax * 0.72) : top;
				}

				if (!statLoaded && r[5] !== null) {
					var mtd = parseMtd(r[5]),
					    ci = parseCpuInfo(r[8]),
					    freq = 0;

					if (r[9] && Number(r[9]) > 0)
						freq = Math.round(Number(r[9]) / 1000);
					else if (ci.mhz > 0)
						freq = Math.round(ci.mhz);
					else if (ci.bogo > 0)
						freq = Math.round(ci.bogo * 1.5);

					mtdTotal = mtd.total;
					mtdParts = mtd.parts;
					renderFlash();

					var sysType = (ci.system || '').replace(/\s+ver.*$/i, ''),
					    chip = (sysType.match(/MT\d{4}[A-Za-z]*/) || [ sysType || '未知' ])[0];

					refs.info.textContent = '';
					[ [ '设备型号', (r[7] || '').trim() || '未知' ],
						  [ 'CPU 型号', chip ],
						  [ 'CPU 频率', freq > 0 ? freq + ' MHz' + (r[9] && Number(r[9]) > 0 ? '' : '（估算）') : '未知' ],
						  [ 'CPU 架构', ci.model || '未知' ],
						  [ 'CPU 核数', String(cores || 1) ],
						  [ '内核版本', parseKernel(r[6]) ],
						  [ '运行内存', target.memTotal > 0 ? bytes(target.memTotal) : '—' ],
						  [ 'Flash 大小', mtd.total > 0 ? bytes(mtd.total) : '—' ],
						  [ '固件版本', parseRelease(r[12]) ] ].forEach(function(x) {
						refs.info.appendChild(E('div', {}, [
							E('span', {}, x[0]),
							E('b', {}, x[1])
						]));
					});

					statLoaded = true;
				}

				paintText();

				/* 内存构成图例用采样值刷新，避免跟随动画取整后长期不更新 */
				refs.donutLegend.textContent = '';
				[ [ '已用 ' + bytes(target.memUsed), '#2f7ef7' ],
					  [ '缓存 ' + bytes(target.memCache), '#f0b429' ],
					  [ '可用 ' + bytes(target.memFree), 'rgba(128,128,128,.5)' ] ].forEach(function(x) {
					refs.donutLegend.appendChild(E('span', {}, [
									E('i', { style: 'background:' + x[1] }), x[0]
					]));
				});
			});
		};

		var paintCharts = function(ts) {
			drawMini(cvCpu, cpuHist, BLUE, 100, ts, shown.cpu);

			drawMini(cvMem, memHist, PURPLE, 100, ts,
				shown.memTotal > 0 ? shown.memUsed / shown.memTotal * 100 : 0);

			drawNetCurve(cvNet, rxHist, txHist, netMax || 10, ts, shown.dl, shown.ul);

			if (ts - lastGrid >= GRID_MS) {
				lastGrid = ts;
				drawNetGrid(cvGrid, netMax || 10, ts, rxHist);
			}

			var dk = Math.round(shown.memUsed / (shown.memTotal || 1) * 200) + ':' +
			         Math.round(shown.memCache / (shown.memTotal || 1) * 200) + ':' +
			         Math.round(shown.memFree / (shown.memTotal || 1) * 200);

			if (donutKey !== dk) {
				donutKey = dk;

				drawDonut(cvDonut, [
					{ v: shown.memUsed, c: '#2f7ef7', name: '已用' },
					{ v: shown.memCache, c: '#f0b429', name: '缓存' },
					{ v: shown.memFree, c: 'rgba(128,128,128,.35)', name: '可用' }
				]);


			}
		};

		var animate = function(ts) {
			if (stopped)
				return;

			if (!started)
				started = ts;

			if (root && root.isConnected === false && ts - started > 1200) {
				stopped = true;
				if (pollId) clearInterval(pollId);
				return;
			}

			/* 与采样无关的连续跟随：每一帧都在逼近目标，慢一点也绝不定格 */
			var dt = prevFrame ? Math.min(ts - prevFrame, 120) : 16,
			    k = 1 - Math.exp(-dt / TAU_MS),
			    i, key, d;

			prevFrame = ts;

			for (i = 0; i < KEYS.length; i++) {
				key = KEYS[i];
				d = target[key] - shown[key];

				if (Math.abs(d) < Math.max(0.0008, Math.abs(target[key]) * 0.002))
					shown[key] = target[key];
				else
					shown[key] += d * k;
			}


			if (ts - lastDraw >= DRAW_MS) {
				lastDraw = ts;
				paintCharts(ts);
			}

			frame(animate);
		};

		poll();
		pollId = setInterval(poll, POLL_MS);
		frame(animate);

		return root;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
