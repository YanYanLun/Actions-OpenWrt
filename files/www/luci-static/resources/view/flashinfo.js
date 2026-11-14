'use strict';

'require view';
'require fs';

var NESTED = /^(kernel|rootfs|rootfs_data)$/;

var CSS = [
	'.flashinfo-card{ border:1px solid rgba(0,0,0,.10); border-radius:10px; overflow:hidden; }',
	'.flashinfo-sum{ padding:16px 18px 18px; text-align:center; }',
	'.flashinfo-sum .t{ font-size:13px; opacity:.65; letter-spacing:.5px; }',
	'.flashinfo-sum .v{ font-size:28px; font-weight:700; line-height:1.35; }',
	'.flashinfo-sum .s{ font-size:12px; opacity:.6; margin-top:2px; }',
	'.flashinfo-tbl{ width:100%; border-collapse:collapse; table-layout:fixed; }',
	'.flashinfo-tbl th{ padding:11px 6px; text-align:center; font-size:13px; font-weight:600;',
	'  background:rgba(47,126,247,.10); border-bottom:1px solid rgba(0,0,0,.08); white-space:nowrap; }',
	'.flashinfo-tbl td{ padding:10px 6px; text-align:center; font-size:13px;',
	'  border-bottom:1px solid rgba(0,0,0,.05); }',
	'.flashinfo-tbl tbody tr:nth-child(even){ background:rgba(0,0,0,.025); }',
	'.flashinfo-tbl tbody tr:hover{ background:rgba(47,126,247,.07); }',
	'.flashinfo-tbl tbody tr:last-child td{ border-bottom:none; }',
	'.flashinfo-tbl .dev,.flashinfo-tbl .hex,.flashinfo-tbl .nm{',
	'  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }',
	'.flashinfo-tbl .nm{ font-weight:600; }',
	'.flashinfo-chip{ display:inline-block; padding:2px 10px; border-radius:999px;',
	'  font-size:12px; line-height:1.6; }',
	'.flashinfo-chip.top{ color:#0f7b3f; background:rgba(16,163,74,.14); }',
	'.flashinfo-chip.sub{ color:#8a6235; background:rgba(138,98,53,.14); }',
	'.flashinfo-note{ padding:10px 16px; text-align:center; font-size:12px;',
	'  opacity:.6; border-top:1px solid rgba(0,0,0,.06); }'
].join('\n');

function mib(bytes) {
	return (bytes / 1048576).toFixed(2);
}

function sizeText(bytes) {
	if (bytes < 1048576)
		return (bytes / 1024) + ' KiB';

	return mib(bytes) + ' MiB';
}

function hex8(bytes) {
	return '0x' + bytes.toString(16).toUpperCase().padStart(8, '0');
}

return view.extend({
	load: function() {
		return fs.read('/proc/mtd').catch(function() {
			return '';
		});
	},

	render: function(txt) {
		var parts = [];

		(txt || '').split(/\r?\n/).forEach(function(line) {
			var m = line.match(/^(mtd\d+):\s+([0-9a-f]+)\s+([0-9a-f]+)\s+"(.+)"/i);

			if (m)
				parts.push({
					dev: m[1],
					size: parseInt(m[2], 16),
					erase: parseInt(m[3], 16),
					name: m[4]
				});
		});

		var total = 0;

		parts.forEach(function(p) {
			if (!NESTED.test(p.name))
				total += p.size;
		});

		var rows = parts.map(function(p) {
			var nested = NESTED.test(p.name);

			return E('tr', {}, [
				E('td', { class: 'dev' }, p.dev),
				E('td', { class: 'nm' }, p.name),
				E('td', {}, sizeText(p.size)),
				E('td', { class: 'hex' }, hex8(p.size)),
				E('td', {}, Math.round(p.erase / 1024) + ' KiB'),
				E('td', {}, E('span', { class: nested ? 'flashinfo-chip sub' : 'flashinfo-chip top' },
					nested ? '子分区' : '顶层'))
			]);
		});

		var th = function(t) {
			return E('th', {}, t);
		};

		return E('div', {}, [
			E('style', {}, CSS),
			E('h2', {}, 'Flash 分区信息'),
			E('div', { class: 'flashinfo-card' }, [
				E('div', { class: 'flashinfo-sum' }, [
					E('div', { class: 't' }, 'Flash 总容量（顶层分区合计）'),
					E('div', { class: 'v' }, mib(total) + ' MiB'),
					E('div', { class: 's' },
						total + ' 字节 / ' + hex8(total) +
						' · 基准：16MB=16777216，32MB=33554432，64MB=67108864')
				]),
				E('table', { class: 'flashinfo-tbl' }, [
					E('colgroup', {}, [
						E('col', { style: 'width:11%' }),
						E('col', { style: 'width:21%' }),
						E('col', { style: 'width:14%' }),
						E('col', { style: 'width:22%' }),
						E('col', { style: 'width:12%' }),
						E('col', { style: 'width:20%' })
					]),
					E('thead', {}, [
						E('tr', {}, [
							th('设备'), th('名称'), th('大小'),
							th('十六进制'), th('擦除块'), th('类型')
						])
					]),
					E('tbody', {}, rows)
				]),
				E('div', { class: 'flashinfo-note' },
					'数据来源 /proc/mtd；kernel / rootfs / rootfs_data 是固件内子分区，不重复计入总量。')
			])
		]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
