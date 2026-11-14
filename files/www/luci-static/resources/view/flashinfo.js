'use strict';

'require view';
'require fs';
'require ui';

var NESTED = /^(kernel|rootfs|rootfs_data)$/;

function mib(bytes) {
	return (bytes / 1048576).toFixed(2);
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

			return E('tr', { class: 'tr' }, [
				E('td', { class: 'td' }, p.dev),
				E('td', { class: 'td' }, p.name),
				E('td', { class: 'td', style: 'text-align:right' }, mib(p.size) + ' MiB'),
				E('td', { class: 'td', style: 'text-align:right' }, '0x' + p.size.toString(16).toUpperCase().padStart(8, '0')),
				E('td', { class: 'td', style: 'text-align:right' }, (p.erase / 1024) + ' KiB'),
				E('td', { class: 'td' }, nested ? '固件内子分区' : '顶层分区')
			]);
		});

		var summary = E('div', { class: 'cbi-section' }, [
			E('h3', {}, 'Flash 总容量（顶层分区合计）'),
			E('div', { style: 'font-size:1.6em;font-weight:bold' }, mib(total) + ' MiB'),
			E('div', { style: 'opacity:.7;margin-top:6px' },
				total + ' 字节 / 0x' + total.toString(16).toUpperCase() +
				'（基准：16MB=16777216，32MB=33554432，64MB=67108864）')
		]);

		return E('div', {}, [
			E('h2', {}, 'Flash 分区信息'),
			summary,
			E('div', { class: 'cbi-section' }, [
				E('table', { class: 'table', style: 'width:100%' }, [
					E('tr', { class: 'tr table-titles' }, [
						E('th', { class: 'th' }, '设备'),
						E('th', { class: 'th' }, '名称'),
						E('th', { class: 'th' }, '大小'),
						E('th', { class: 'th' }, '十六进制'),
						E('th', { class: 'th' }, '擦除块'),
						E('th', { class: 'th' }, '类型')
					]),
					...rows
				])
			]),
			E('div', { class: 'cbi-section' }, [
				E('p', { style: 'opacity:.7' },
					'数据来源：/proc/mtd。kernel / rootfs / rootfs_data 是固件分区里的子分区，不重复计入总量。')
			])
		]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
