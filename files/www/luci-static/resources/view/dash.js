'use strict';

'require view';
'require fs';

var NESTED = /^(kernel|rootfs|rootfs_data)$/;
var HIST = 60;
var PAGE_TITLE = '仪表盘';

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

function drawSeries(ctx, W, H, series, style, scaleMax) {
	if (!series || series.length < 2)
		return;

	var max = scaleMax || Math.max.apply(null, series.concat([ 1 ]));

	if (max <= 0) max = 1;

	var n = series.length,
	    step = W / (n - 1),
	    pts = series.map(function(v, i) {
	    	return [ i * step, H - (Math.min(v, max) / max) * (H - 16) - 8 ];
	    });

	var g = ctx.createLinearGradient(0, 0, 0, H);

	g.addColorStop(0, style.fillTop);
	g.addColorStop(1, style.fillBottom);

	ctx.beginPath();
	smoothPath(ctx, pts);
	ctx.lineTo(W, H);
	ctx.lineTo(0, H);
	ctx.closePath();
	ctx.fillStyle = g;
	ctx.fill();

	ctx.beginPath();
	smoothPath(ctx, pts);
	ctx.strokeStyle = style.stroke;
	ctx.lineWidth = 2;
	ctx.stroke();

	ctx.beginPath();
	ctx.arc(pts[n - 1][0], pts[n - 1][1], 2.6, 0, Math.PI * 2);
	ctx.fillStyle = style.stroke;
	ctx.fill();
}

function drawChart(cv, seriesList, scaleMax) {
	var ctx = cv.getContext('2d');

	ctx.clearRect(0, 0, cv.width, cv.height);

	seriesList.forEach(function(s) {
		drawSeries(ctx, cv.width, cv.height, s.data, s, scaleMax);
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
		ctx.arc(cx, cy, r, a0, a1);
		ctx.arc(cx, cy, r0, a1, a0, true);
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
		    statLoaded = false, last = {},
		    refs = {};

		var css = [
			'.home{ font-size:13px; }',
			'.home-grid{ display:grid; gap:12px; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); }',
			'.home-card{ border:1px solid rgba(0,0,0,.08); border-radius:10px; padding:12px 14px; }',
			'.home-card h4{ margin:0 0 8px; font-size:12px; font-weight:600; opacity:.62; letter-spacing:.4px; }',
			'.home-big{ font-size:25px; font-weight:700; line-height:1.25; }',
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
			'.home-head .val{ font-size:12px; opacity:.72; }',
			'.home-donut{ margin:0 auto; width:150px; height:150px; }',
			'@media (max-width:820px){ .home-wide{ grid-template-columns:minmax(0,1fr); } }'
		].join('\n');

		var cvCpu = E('canvas', { class: 'home-cv', width: 600, height: 120, style: 'height:58px' }),
		    cvMem = E('canvas', { class: 'home-cv', width: 600, height: 120, style: 'height:58px' }),
		    cvNet = E('canvas', { class: 'home-cv', width: 1200, height: 300, style: 'height:170px' }),
		    cvDonut = E('canvas', { class: 'home-cv home-donut', width: 320, height: 320 }),
		    cvFlash = E('canvas', { class: 'home-cv', width: 1200, height: 24, style: 'height:12px' });

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

		var root = E('div', { class: 'home' }, [
			E('style', {}, css),
			E('h2', {}, PAGE_TITLE),
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

		var BLUE = { stroke: '#2f7ef7', fillTop: 'rgba(47,126,247,.32)', fillBottom: 'rgba(47,126,247,.02)' },
		    GREEN = { stroke: '#10a374', fillTop: 'rgba(16,163,116,.26)', fillBottom: 'rgba(16,163,116,.02)' },
		    PURPLE = { stroke: '#7c5cf0', fillTop: 'rgba(124,92,240,.28)', fillBottom: 'rgba(124,92,240,.02)' };

		var tick = function() {
			var t = Date.now();

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
					push(cpuHist, pct);
					refs.cpuVal.textContent = pct.toFixed(1) + ' %';
					refs.cpuSub.textContent = cpuCores(r[0]) + ' 核 · 每 4 秒采样';
					drawChart(cvCpu, [ { data: cpuHist, stroke: BLUE.stroke, fillTop: BLUE.fillTop, fillBottom: BLUE.fillBottom } ], 100);
				}

				prevCpu = cpu;

				var mem = parseMem(r[1]);

				if (mem) {
					var usedPct = mem.used / mem.total * 100;

					push(memHist, usedPct);
					refs.memVal.textContent = usedPct.toFixed(1) + ' %';
					refs.memSub.textContent = bytes(mem.used) + ' / ' + bytes(mem.total);
					drawChart(cvMem, [ { data: memHist, stroke: PURPLE.stroke, fillTop: PURPLE.fillTop, fillBottom: PURPLE.fillBottom } ], 100);

					drawDonut(cvDonut, [
						{ v: mem.used, c: '#2f7ef7' },
						{ v: mem.cache, c: '#f0b429' },
						{ v: mem.free, c: 'rgba(128,128,128,.35)' }
					]);

					refs.donutLegend.textContent = '';
					[ [ '已用 ' + bytes(mem.used), '#2f7ef7' ],
					  [ '缓存 ' + bytes(mem.cache), '#f0b429' ],
					  [ '可用 ' + bytes(mem.free), 'rgba(128,128,128,.5)' ] ].forEach(function(x) {
						refs.donutLegend.appendChild(E('span', {}, [
							E('i', { style: 'background:' + x[1] }), x[0]
						]));
					});
				}

				var net = parseNet(r[2]);

				if (net && prevNet && prevT) {
					var dt = (t - prevT) / 1000;

					if (dt > 0.5) {
						var rx = Math.max(0, (net.rx - prevNet.rx) / dt) / 1024,
						    tx = Math.max(0, (net.tx - prevNet.tx) / dt) / 1024;

						push(rxHist, rx);
						push(txHist, tx);

						refs.netVal.textContent = '↓ ' + rate(rx * 1024);
						refs.netSub.textContent = '↑ ' + rate(tx * 1024) + ' · 接口 ' + net.name;
						refs.netHead.textContent = '下载 ' + rate(rx * 1024) + ' ／ 上传 ' + rate(tx * 1024);

						var top = Math.max.apply(null, rxHist.concat(txHist).concat([ 10 ])) * 1.06;

						drawChart(cvNet, [
							{ data: rxHist, stroke: BLUE.stroke, fillTop: BLUE.fillTop, fillBottom: BLUE.fillBottom },
							{ data: txHist, stroke: GREEN.stroke, fillTop: GREEN.fillTop, fillBottom: GREEN.fillBottom }
						], top);
					}
				}

				prevNet = net;
				prevT = t;

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
					  [ 'CPU 核数', String(cpuCores(r[0])) ] ].forEach(function(x) {
						refs.info.appendChild(E('div', {}, [ E('span', {}, x[0]), x[1] ]));
					});

					statLoaded = true;
				}
			});
		};

		tick();
		setInterval(tick, 4000);

		return root;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
