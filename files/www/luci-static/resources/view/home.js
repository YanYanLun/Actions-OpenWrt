'use strict';

'require view';
'require fs';

var NESTED = /^(kernel|rootfs|rootfs_data)$/;
var HIST = 60;
var POLL_MS = 1000;
var TEXT_MS = 50;
var DRAW_MS = 66;
var PAGE_TITLE = '首页';

function parseCpu(txt) {
	var m = (txt || '').match(/(?:^|\n)cpu\s+([^\n]+)/);

	if (!m)
		return null;

	var v = m[1].trim().split(/\s+/).map(Number);

	return {
		idle: (v[3] || 0) + (v[4] || 0),
		busy: (v[0] || 0) + (v[1] || 0) + (v[2] || 0) + (v[5] || 0) + (v[6] || 0) + (v[7] || 0),
		total: (v[3] || 0) + (v[4] || 0) + (v[0] || 0) + (v[1] || 0) + (v[2] || 0) + (v[5] || 0) + (v[6] || 0) + (v[7] || 0)
	};
}

function cpuPercent(prev, cur) {
	if (!prev || !cur)
		return null;

	var dt = cur.total - prev.total,
	    db = cur.busy - prev.busy;

	if (dt <= 0)
		return null;

	return Math.max(0, Math.min(100, db * 100 / dt));
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

function drawSeries(ctx, W, H, series, style, scaleMax, frac) {
	if (!series || series.length < 2)
		return;

	var max = scaleMax || Math.max.apply(null, series.concat([ 1 ]));

	if (max <= 0) max = 1;

	var step = W / (HIST - 1),
	    n = series.length,
	    off = (frac || 0) * step,
	    pts = series.map(function(v, i) {
	    	return [ W - (n - 1 - i) * step - off,
	    	        H - (Math.min(v, max) / max) * (H - 16) - 8 ];
	    });

	var g = ctx.createLinearGradient(0, 0, 0, H);

	g.addColorStop(0, style.fillTop);
	g.addColorStop(1, style.fillBottom);

	ctx.beginPath();
	smoothPath(ctx, pts);
	ctx.lineTo(W, pts[n - 1][1]);
	ctx.lineTo(W, H);
	ctx.lineTo(Math.max(pts[0][0], 0), H);
	ctx.lineTo(Math.max(pts[0][0], 0), pts[0][1]);
	ctx.closePath();
	ctx.fillStyle = g;
	ctx.fill();

	ctx.beginPath();
	smoothPath(ctx, pts);
	ctx.lineTo(W, pts[n - 1][1]);
	ctx.strokeStyle = style.stroke;
	ctx.lineWidth = 2;
	ctx.stroke();

	ctx.beginPath();
	ctx.arc(pts[n - 1][0], pts[n - 1][1], 2.4, 0, Math.PI * 2);
	ctx.fillStyle = style.stroke;
	ctx.fill();
}

function drawChart(cv, seriesList, scaleMax, frac) {
	var ctx = cv.getContext('2d');

	ctx.clearRect(0, 0, cv.width, cv.height);

	seriesList.forEach(function(s) {
		drawSeries(ctx, cv.width, cv.height, s.data, s, scaleMax, frac);
	});
}

function drawDonut(cv, segs) {
	var ctx = cv.getContext('2d'),
	    W = cv.width,
	    H = cv.height;

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
	smooth: smoothPath,

	load: function() {
		return Promise.resolve(null);
	},

	render: function() {
		var cpuHist = [], memHist = [], rxHist = [], txHist = [],
		    prevCpu = null, prevNet = null, prevT = null,
		    statLoaded = false, last = {}, refs = {},
		    target = { cpu: 0, memUsed: 0, memCache: 0, memFree: 0, memTotal: 0, dl: 0, ul: 0 },
		    shown = { cpu: 0, memUsed: 0, memCache: 0, memFree: 0, memTotal: 0, dl: 0, ul: 0 },
		    tipDl = 0, tipUl = 0, tipCpu = 0, tipMem = 0,
		    started = 0, lastTs = 0, lastPoll = 0, lastDraw = 0, lastText = 0,
		    pollId = 0, stopped = false, donutKey = '';

		var css = [
			'.home{ font-size:13px; }',
			'.home-grid{ display:grid; gap:12px; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); }',
			'.home-card{ border:1px solid rgba(0,0,0,.08); border-radius:10px; padding:12px 14px; }',
			'.home-card h4{ margin:0 0 8px; font-size:12px; font-weight:600; opacity:.62; letter-spacing:.4px; }',
			'.home-big{ font-size:25px; font-weight:700; line-height:1.25; font-variant-numeric:tabular-nums; }',
			'.home-sub{ font-size:12px; opacity:.6; margin-bottom:8px; }',
			'.home-cv{ display:block; width:100%; border-radius:6px; }',
			'.home-wide{ display:grid; gap:12px; grid-template-columns:minmax(0,2fr) minmax(0,1fr); margin-top:12px; }',
			'.home-legend{ display:flex; gap:14px; flex-wrap:wrap; font-size:12px; margin-top:8px; }',
			'.home-legend i{ display:inline-block; width:9px; height:9px; border-radius:2px; margin-right:5px; vertical-align:middle; }',
			'.home-info{ display:grid; gap:8px; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); margin-top:12px;',
			'  font-size:12px; border:1px solid rgba(0,0,0,.06); border-radius:10px; padding:10px 14px; }',
			'.home-info span{ opacity:.6; margin-right:6px; }',
			'.home-head{ display:flex; align-items:center; justify-content:space-between; margin-bottom:8px; }',
			'.home-head h4{ margin:0; }',
			'.home-head .val{ font-size:12px; opacity:.72; font-variant-numeric:tabular-nums; }',
			'.home-donut{ margin:0 auto; width:150px; height:150px; }',
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
			/* SHORTCUTS:END */			'@media (max-width:820px){ .home-wide{ grid-template-columns:minmax(0,1fr); } }'
		].join('\n');

		var cvCpu = E('canvas', { class: 'home-cv', width: 480, height: 96, style: 'height:52px' }),
		    cvMem = E('canvas', { class: 'home-cv', width: 480, height: 96, style: 'height:52px' }),
		    cvNet = E('canvas', { class: 'home-cv', width: 900, height: 220, style: 'height:170px' }),
		    cvDonut = E('canvas', { class: 'home-cv home-donut', width: 320, height: 320 }),
		    cvFlash = E('canvas', { class: 'home-cv', width: 900, height: 24, style: 'height:12px' });

		refs.cpuVal = E('div', { class: 'home-big' }, '—');
		refs.cpuSub = E('div', { class: 'home-sub' }, '采样中…');
		refs.memVal = E('div', { class: 'home-big' }, '—');
		refs.memSub = E('div', { class: 'home-sub' }, '采样中…');
		refs.netVal = E('div', { class: 'home-big' }, '—');
		refs.netSub = E('div', { class: 'home-sub' }, '—');
		refs.netHead = E('div', { class: 'val' }, '—');
		refs.upVal = E('div', { class: 'home-big' }, '—');
		refs.upSub = E('div', { class: 'home-sub' }, '—');
		refs.flashVal = E('div', { class: 'home-big' }, '—');
		refs.flashSub = E('div', { class: 'home-sub' }, '—');
		refs.donutLegend = E('div', { class: 'home-legend' });
		refs.flashLegend = E('div', { class: 'home-legend' });
		refs.info = E('div', { class: 'home-info' });

		/* SHORTCUTS:BEGIN */
		var quick = E('div', { class: 'home-quick' }, SHORTCUTS.map(function(s) {
			var link = (typeof L !== 'undefined' && L.url) ? L.url(s.p) : ('/cgi-bin/luci/' + s.p),
			    ico = E('div', { class: 'ico' });

			ico.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="' + s.c +
				'" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' + s.i + '</svg>';

			return E('a', { href: link, style: 'background:' + s.bg }, [ ico, E('span', {}, s.t) ]);
		}));
		/* SHORTCUTS:END */
		var root = E('div', { class: 'home' }, [
			E('style', {}, css),
			E('h2', {}, PAGE_TITLE),
			quick,
			E('div', { class: 'home-grid' }, [
				E('div', { class: 'home-card' }, [ E('h4', {}, 'CPU 使用率'), refs.cpuVal, refs.cpuSub, cvCpu ]),
				E('div', { class: 'home-card' }, [ E('h4', {}, '内存占用'), refs.memVal, refs.memSub, cvMem ]),
				E('div', { class: 'home-card' }, [ E('h4', {}, '实时网速'), refs.netVal, refs.netSub ]),
				E('div', { class: 'home-card' }, [ E('h4', {}, '运行时间 / 负载'), refs.upVal, refs.upSub ])
			]),
			E('div', { class: 'home-wide' }, [
				E('div', { class: 'home-card' }, [
					E('div', { class: 'home-head' }, [ E('h4', {}, '网速'), refs.netHead ]),
					cvNet,
					E('div', { class: 'home-legend' }, [
						E('span', {}, [ E('i', { style: 'background:#2f7ef7' }), '下行' ]),
						E('span', {}, [ E('i', { style: 'background:#10a374' }), '上行' ])
					])
				]),
				E('div', { class: 'home-card' }, [
					E('h4', {}, '内存构成'),
					cvDonut,
					refs.donutLegend
				])
			]),
			E('div', { class: 'home-card', style: 'margin-top:12px' }, [
				E('h4', {}, 'Flash 存储'),
				refs.flashVal,
				refs.flashSub,
				cvFlash,
				refs.flashLegend
			]),
			refs.info
		]);

		var safe = function(p) {
			return p.catch(function() { return ''; });
		};

		var push = function(arr, v) {
			arr.push(v);
			while (arr.length > HIST) arr.shift();
		};

		var frame = function(fn) {
			if (typeof requestAnimationFrame === 'function') requestAnimationFrame(fn);
			else setTimeout(function() { fn(Date.now()); }, 16);
		};

		var nowMs = function() {
			return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
		};

		var BLUE = { stroke: '#2f7ef7', fillTop: 'rgba(47,126,247,.32)', fillBottom: 'rgba(47,126,247,.02)' },
		    GREEN = { stroke: '#10a374', fillTop: 'rgba(16,163,116,.26)', fillBottom: 'rgba(16,163,116,.02)' },
		    PURPLE = { stroke: '#7c5cf0', fillTop: 'rgba(124,92,240,.28)', fillBottom: 'rgba(124,92,240,.02)' };

		var netName = '', cores = 0;

		var poll = function() {
			var t = nowMs();

			Promise.all([
				safe(fs.read('/proc/stat')),
				safe(fs.read('/proc/meminfo')),
				safe(fs.read('/proc/net/dev')),
				safe(fs.read('/proc/uptime')),
				safe(fs.read('/proc/loadavg')),
				statLoaded ? Promise.resolve(last.mtd) : safe(fs.read('/proc/mtd')),
				statLoaded ? Promise.resolve(last.ver) : safe(fs.read('/proc/version')),
				statLoaded ? Promise.resolve(last.model) : safe(fs.read('/proc/device-tree/model'))
			]).then(function(r) {
				var cpu = parseCpu(r[0]),
				    pct = cpuPercent(prevCpu, cpu);

				if (pct !== null) {
					target.cpu = pct;
					push(cpuHist, pct);
				}

				prevCpu = cpu;
				cores = cpuCores(r[0]) || cores;

				var mem = parseMem(r[1]);

				if (mem) {
					target.memUsed = mem.used;
					target.memCache = mem.cache;
					target.memFree = mem.free;
					target.memTotal = mem.total;
					push(memHist, mem.used / mem.total * 100);
				}

				var net = parseNet(r[2]);

				if (net && prevNet && prevT) {
					var dt = (t - prevT) / 1000;

					if (dt > 0.2) {
						var dl = Math.max(0, (net.rx - prevNet.rx) / dt) / 1024,
						    ul = Math.max(0, (net.tx - prevNet.tx) / dt) / 1024;

						target.dl = dl;
						target.ul = ul;
						push(rxHist, dl);
						push(txHist, ul);
						netName = net.name;
					}
				}

				prevNet = net;
				prevT = t;
				lastPoll = nowMs();

				refs.upVal.textContent = uptimeText(parseUptime(r[3]));
				refs.upSub.textContent = '负载 ' + parseLoad(r[4]).map(function(x) {
					return x.toFixed(2);
				}).join(' / ');

				if (!statLoaded) {
					last.mtd = r[5];
					last.ver = r[6];
					last.model = r[7];

					var mtd = parseMtd(r[5]);

					if (mtd.total > 0) {
						refs.flashVal.textContent = mib(mtd.total);
						refs.flashSub.textContent = '分区 ' + mtd.parts.length + ' 个（顶层 ' +
							mtd.parts.filter(function(p) { return !p.nested; }).length + '）';

						var colors = [ '#9aa4b2', '#f0b429', '#7c5cf0', '#2f7ef7' ],
						    tops = mtd.parts.filter(function(p) { return !p.nested; });

						drawStack(cvFlash, tops.map(function(p, i) {
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

					refs.info.textContent = '';
					[ [ '型号', (r[7] || '').trim() || '未知' ],
					  [ '内核', parseKernel(r[6]) ],
					  [ 'CPU 核数', String(cores) ] ].forEach(function(x) {
						refs.info.appendChild(E('div', {}, [ E('span', {}, x[0]), x[1] ]));
					});

					statLoaded = true;
				}
			});
		};

		var paintText = function() {
			var memPct = shown.memTotal > 0 ? shown.memUsed / shown.memTotal * 100 : 0,
			    tCpu = shown.cpu.toFixed(1) + ' %',
			    tMem = memPct.toFixed(1) + ' %',
			    tDl = '↓ ' + rate(shown.dl * 1024),
			    tUl = '↑ ' + rate(shown.ul * 1024) + (netName ? ' · 接口 ' + netName : '');

			if (refs.cpuVal.textContent !== tCpu) refs.cpuVal.textContent = tCpu;
			if (refs.memVal.textContent !== tMem) refs.memVal.textContent = tMem;
			if (refs.netVal.textContent !== tDl) refs.netVal.textContent = tDl;
			if (refs.netSub.textContent !== tUl) refs.netSub.textContent = tUl;

			var tMemSub = bytes(shown.memUsed) + ' / ' + bytes(shown.memTotal),
			    tCpuSub = cores + ' 核 · 实时刷新',
			    tHead = '下载 ' + rate(shown.dl * 1024) + ' ／ 上传 ' + rate(shown.ul * 1024);

			if (refs.cpuSub.textContent !== tCpuSub) refs.cpuSub.textContent = tCpuSub;
			if (refs.memSub.textContent !== tMemSub) refs.memSub.textContent = tMemSub;
			if (refs.netHead.textContent !== tHead) refs.netHead.textContent = tHead;
		};

		var paintCharts = function(ts) {
			var frac = lastPoll ? Math.max(0, Math.min(1, (ts - lastPoll) / POLL_MS)) : 0;

			if (cpuHist.length >= 2)
				drawChart(cvCpu, [ {
					data: cpuHist.slice(0, -1).concat([ shown.cpu ]),
					stroke: BLUE.stroke, fillTop: BLUE.fillTop, fillBottom: BLUE.fillBottom
				} ], 100, frac);

			if (memHist.length >= 2)
				drawChart(cvMem, [ {
					data: memHist.slice(0, -1).concat([ shown.memTotal > 0 ? shown.memUsed / shown.memTotal * 100 : 0 ]),
					stroke: PURPLE.stroke, fillTop: PURPLE.fillTop, fillBottom: PURPLE.fillBottom
				} ], 100, frac);

			if (rxHist.length >= 2) {
				var top = Math.max.apply(null, rxHist.concat(txHist).concat([ shown.dl, shown.ul, 10 ])) * 1.06;

				drawChart(cvNet, [
					{ data: rxHist.slice(0, -1).concat([ shown.dl ]), stroke: BLUE.stroke, fillTop: BLUE.fillTop, fillBottom: BLUE.fillBottom },
					{ data: txHist.slice(0, -1).concat([ shown.ul ]), stroke: GREEN.stroke, fillTop: GREEN.fillTop, fillBottom: GREEN.fillBottom }
				], top, frac);
			}

			/* 饼图按 0.5% 量化去重：数值稳定时不重复重绘，省这颗 CPU */
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
			}

			if (refs.donutLegend._k !== dk) {
				refs.donutLegend._k = dk;
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

		var KEYS = [ 'cpu', 'memUsed', 'memCache', 'memFree', 'memTotal', 'dl', 'ul' ];

		var animate = function(ts) {
			if (stopped)
				return;

			if (!started)
				started = ts;

			/* 页面切走后自动停机，避免后台空转 */
			if (root && root.isConnected === false && ts - started > 1200) {
				stopped = true;
				if (pollId) clearInterval(pollId);
				return;
			}

			if (!lastTs)
				lastTs = ts;

			var dt = Math.min(Math.max(ts - lastTs, 0), 250);

			lastTs = ts;

			/* 数字：按时间常数 ~160ms 指数逼近，肉眼看到的是连续爬升而不是秒跳 */
			var a = 1 - Math.exp(-dt / 160);

			for (var i = 0; i < KEYS.length; i++) {
				var k = KEYS[i];

				shown[k] += (target[k] - shown[k]) * a;

				if (Math.abs(target[k] - shown[k]) < 0.004) shown[k] = target[k];
			}

			tipCpu = shown.cpu;
			tipUl = shown.ul;
			tipDl = shown.dl;
			tipMem = shown.memTotal > 0 ? shown.memUsed / shown.memTotal * 100 : 0;

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
