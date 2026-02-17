import type { OutputFormat } from '../types.js'

export function formatTable(
	headers: string[],
	rows: (string | number | undefined | null)[][],
	format: OutputFormat,
): string {
	if (format === 'json') {
		return JSON.stringify(
			rows.map((row) => {
				const obj: Record<string, string | number | null> = {}
				for (let i = 0; i < headers.length; i++) {
					obj[headers[i]] = row[i] ?? null
				}
				return obj
			}),
			null,
			2,
		)
	}

	if (format === 'plain') {
		const headerLine = headers.join('\t')
		const dataLines = rows.map((row) => row.map((v) => v ?? '').join('\t'))
		return [headerLine, ...dataLines].join('\n')
	}

	// Markdown table
	const colWidths = headers.map((h, i) => {
		const maxData = rows.reduce((max, row) => Math.max(max, String(row[i] ?? '').length), 0)
		return Math.max(h.length, maxData)
	})

	const headerLine = `| ${headers.map((h, i) => h.padEnd(colWidths[i])).join(' | ')} |`
	const separator = `| ${colWidths.map((w) => '-'.repeat(w)).join(' | ')} |`
	const dataLines = rows.map(
		(row) =>
			`| ${row.map((v, i) => String(v ?? '').padEnd(colWidths[i])).join(' | ')} |`,
	)

	return [headerLine, separator, ...dataLines].join('\n')
}

export function formatKeyValue(
	data: Record<string, string | number | undefined | null>,
	format: OutputFormat,
): string {
	if (format === 'json') {
		return JSON.stringify(data, null, 2)
	}

	if (format === 'plain') {
		return Object.entries(data)
			.filter(([_, v]) => v != null)
			.map(([k, v]) => `${k}\t${v}`)
			.join('\n')
	}

	// Markdown key-value
	const entries = Object.entries(data).filter(([_, v]) => v != null)
	const maxKeyLen = entries.reduce((max, [k]) => Math.max(max, k.length), 0)
	return entries.map(([k, v]) => `**${k.padEnd(maxKeyLen)}**: ${v}`).join('\n')
}

export function formatNumber(n: number, decimals = 2): string {
	if (Math.abs(n) >= 1e12) return `${(n / 1e12).toFixed(decimals)}T`
	if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(decimals)}B`
	if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(decimals)}M`
	if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(decimals)}K`
	return n.toFixed(decimals)
}

export function formatCurrency(n: number, currency = 'USD'): string {
	return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(n)
}

export function formatPercent(n: number): string {
	const sign = n >= 0 ? '+' : ''
	return `${sign}${n.toFixed(2)}%`
}
