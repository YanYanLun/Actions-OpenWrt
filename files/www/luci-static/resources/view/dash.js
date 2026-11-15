'use strict';

'require view';
'require fs';

var NESTED = /^(kernel|rootfs|rootfs_data)$/;
var HIST = 60;
var POLL_MS = 1000;      /* 采样间隔 */
var TEXT_MS = 33;        /* 数字 30fps */
var DRAW_MS = 33;        /* 曲线 30fps */
var GRID_MS = 250;       /* 坐标轴层 4fps：刻度跟着曲线一起滑，几乎不耗 */
var TAU_MS = 300;        /* 数值跟随时间常数：永不定格，连续逼近 */

var NET_W = 640, NET_H = 184;
var MINI_W = 320, MINI_H = 72;
var PAD = { l: 46, r: 10, t: 8, b: 22 };

var PAGE_TITLE = '仪表盘';

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

/* 坐标轴层：网格 + 纵轴刻度 + 时间刻度，4fps 重画，跟着曲线一起左滑 */
function drawNetGrid(cv, max, now, series) {
	var ctx = fitLayer(cv, NET_W, NET_H),
	    W = NET_W,
	    H = NET_H,
	    rect = { x: PAD.l, y: PAD.t, w: W - PAD.l - PAD.r, h: H - PAD.t - PAD.b },
	    step = rect.w / (HIST - 1),
	    sp = step / POLL_MS,
	    i, y, v, x, t;

	ctx.clearRect(0, 0, W, H);

	ctx.lineWidth = 1;
	ctx.strokeStyle = 'rgba(0,0,0,.07)';
	ctx.fillStyle = 'rgba(0,0,0,.45)';
	ctx.font = '11px system-ui,-apple-system,sans-serif';
	ctx.textAlign = 'right';
	ctx.textBaseline = 'middle';

	for (i = 0; i <= 4; i++) {
		y = rect.y + rect.h * i / 4;
		v = max * (1 - i / 4);

		ctx.beginPath();
		ctx.moveTo(rect.x, y + .5);
		ctx.lineTo(rect.x + rect.w, y + .5);
		ctx.stroke();

		ctx.fillText(shortRate(v), PAD.l - 7, y);
	}

	ctx.textAlign = 'center';
	ctx.textBaseline = 'top';

	if (!series || !series.length)
		return;

	for (i = series.length - 1; i >= 0; i -= 15) {
		t = series[i].w;
		x = rect.x + rect.w - (now - series[i].t) * sp;

		if (x < rect.x + 14 || x > rect.x + rect.w - 14)
			continue;

		ctx.fillText(clockText(t), x, rect.y + rect.h + 8);
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
	    r = Math.min(W, H) / 2 - 6,
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
		    netMax = 0, netName = '', cores = 0,
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
			'.home-two{ display:grid; gap:12px; grid-template-columns:minmax(0,1fr) minmax(0,1fr); margin-top:12px; }',
			'.home-rate{ display:grid; gap:10px; grid-template-columns:1fr 1fr; }',
			'.home-rate .lb{ font-size:12px; opacity:.62; margin-bottom:2px; }',
			'.home-legend{ display:flex; gap:14px; flex-wrap:wrap; font-size:12px; margin-top:8px; }',
			'.home-legend.center{ justify-content:center; gap:22px; }',
			'.home-legend i{ display:inline-block; width:9px; height:9px; border-radius:2px; margin-right:5px; vertical-align:middle; }',
			'.home-info{ display:grid; gap:10px; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); font-size:12px; }',
			'.home-info span{ display:block; opacity:.58; margin-bottom:3px; }',
			'.home-info b{ font-weight:600; font-variant-numeric:tabular-nums; }',
			'.home-head{ display:flex; align-items:center; justify-content:space-between; margin-bottom:8px; }',
			'.home-head h4{ margin:0; }',
			'.home-head .val{ font-size:12px; opacity:.72; font-variant-numeric:tabular-nums; }',
			'.home-donut{ margin:0 auto; width:150px; height:150px; }',
			'@media (max-width:820px){ .home-wide, .home-two{ grid-template-columns:minmax(0,1fr); } }'
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

		var root = E('div', { class: 'home' }, [
			E('style', {}, css),
			E('h2', {}, PAGE_TITLE),
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
			E('div', { class: 'home-two' }, [
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
				])
			])
		]);

		var safe = function(p) {
			return p.catch(function() { return ''; });
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
			var memPct = shown.memTotal > 0 ? shown.memUsed / shown.memTotal * 100 : 0,
			    tCpu = shown.cpu.toFixed(1) + ' %',
			    tMem = memPct.toFixed(1) + ' %',
			    tDl = rate(shown.dl * 1024),
			    tUl = rate(shown.ul * 1024),
			    tIf = (netName ? '接口 ' + netName : '—') + ' · 每秒采样 · 平滑刷新 v4',
			    tCpuSub = cores + ' 核 · 平滑刷新 v4',
			    tMemSub = bytes(shown.memUsed) + ' / ' + bytes(shown.memTotal),
			    tHead = '下载 ' + shortRate(shown.dl) + ' ／ 上传 ' + shortRate(shown.ul);

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
				statLoaded ? Promise.resolve(null) : safe(fs.read('/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq'))
			]).then(function(r) {
				var cpu = parseCpu(r[0]),
				    pct = cpuPercent(prevCpu, cpu);

				if (pct !== null) {
					emaCpu = (emaCpu === null) ? pct : (emaCpu * 0.45 + pct * 0.55);
					target.cpu = emaCpu;
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

				if (slow) {
					refs.upVal.textContent = uptimeText(parseUptime(r[3]));
					refs.upSub.textContent = '负载 ' + parseLoad(r[4]).map(function(x) {
						return x.toFixed(2);
					}).join(' / ');
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

					if (mtd.total > 0) {
						refs.flashVal.textContent = mib(mtd.total);
						refs.flashSub.textContent = '分区 ' + mtd.parts.length + ' 个（顶层 ' +
							mtd.parts.filter(function(p) { return !p.nested; }).length + '）';

						var colors = [ '#2f7ef7', '#f0b429', '#7c5cf0', '#10a374', '#e0508b', '#9aa4b2' ],
							    tops = mtd.parts.filter(function(p) { return !p.nested; });

						drawDonut(cvFlashDonut, tops.map(function(p, i) {
							return { v: p.size, c: colors[i % colors.length] };
						}));

						refs.flashLegend.textContent = '';
						tops.forEach(function(p, i) {
							refs.flashLegend.appendChild(E('span', {}, [
								E('i', { style: 'background:' + colors[i % colors.length] }),
								p.name + ' ' + bytes(p.size)
							]));
						});
					}

					var sysType = (ci.system || '').replace(/\s+ver.*$/i, ''),
					    chip = (sysType.match(/MT\d{4}[A-Za-z]*/) || [ sysType || '未知' ])[0];

					refs.info.textContent = '';
					[ [ '设备型号', (r[7] || '').trim() || '未知' ],
						  [ 'CPU 型号', chip ],
						  [ 'CPU 频率', freq > 0 ? freq + ' MHz' + (r[9] && Number(r[9]) > 0 ? '' : '（估算）') : '未知' ],
						  [ 'CPU 架构', ci.model || '未知' ],
						  [ 'CPU 核数', String(cores || 1) ],
						  [ '内核版本', parseKernel(r[6]) ] ].forEach(function(x) {
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
					{ v: shown.memUsed, c: '#2f7ef7' },
					{ v: shown.memCache, c: '#f0b429' },
					{ v: shown.memFree, c: 'rgba(128,128,128,.35)' }
				]);

				refs.donutLegend.textContent = '';
				[ [ '已用 ' + bytes(shown.memUsed), '#2f7ef7' ],
				  [ '缓存 ' + bytes(shown.memCache), '#f0b429' ],
				  [ '可用 ' + bytes(shown.memFree), 'rgba(128,128,128,.5)' ] ].forEach(function(x) {
					refs.donutLegend.appendChild(E('span', {}, [
						E('i', { style: 'background:' + x[1] }), x[0]
					]));
				});
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

			if (ts - lastText >= TEXT_MS) {
				lastText = ts;
				paintText();
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
