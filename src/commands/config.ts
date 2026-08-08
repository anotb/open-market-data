import type { Command } from 'commander'
import { getConfigPath, loadConfig, saveConfig } from '../core/config.js'
import type { GlobalOptions } from '../types.js'

export function registerConfigCommand(program: Command): void {
	const config = program.command('config').description('Manage configuration')

	config
		.command('show')
		.description('Show current configuration')
		.action(() => {
			const opts = program.opts<GlobalOptions>()
			const cfg = loadConfig()
			const redacted = {
				...cfg,
				fredApiKey: cfg.fredApiKey ? '***configured***' : undefined,
				coingeckoApiKey: cfg.coingeckoApiKey ? '***configured***' : undefined,
				finnhubApiKey: cfg.finnhubApiKey ? '***configured***' : undefined,
				alphaVantageApiKey: cfg.alphaVantageApiKey ? '***configured***' : undefined,
			}
			if (opts.format === 'json') {
				console.log(JSON.stringify({ configFile: getConfigPath(), config: redacted }, null, 2))
				return
			}
			if (opts.format === 'plain') {
				console.log(`configFile\t${getConfigPath()}`)
				for (const [key, value] of Object.entries(redacted)) {
					if (value !== undefined) console.log(`${key}\t${String(value)}`)
				}
				return
			}
			console.log(`Config file: ${getConfigPath()}\n`)
			console.log(JSON.stringify(redacted, null, 2))
		})

	config
		.command('set <key> <value>')
		.description('Set a configuration value')
		.action((key: string, value: string) => {
			const opts = program.opts<GlobalOptions>()
			const validKeys = [
				'fredApiKey',
				'coingeckoApiKey',
				'finnhubApiKey',
				'alphaVantageApiKey',
				'edgarUserAgent',
				'defaultFormat',
			]
			if (!validKeys.includes(key)) {
				console.error(`Invalid key: ${key}. Valid keys: ${validKeys.join(', ')}`)
				process.exit(1)
			}
			if (key === 'defaultFormat' && !['markdown', 'json', 'plain'].includes(value)) {
				console.error('Invalid defaultFormat. Expected markdown, json, or plain.')
				process.exit(1)
			}
			saveConfig({ [key]: value })
			const displayValue = key.includes('Key') ? '***' : value
			if (opts.format === 'json') {
				console.log(JSON.stringify({ key, value: displayValue }))
			} else if (opts.format === 'plain') {
				console.log(`${key}\t${displayValue}`)
			} else {
				console.log(`Set ${key} = ${displayValue}`)
			}
		})

	config
		.command('path')
		.description('Show config file path')
		.action(() => {
			const opts = program.opts<GlobalOptions>()
			console.log(
				opts.format === 'json' ? JSON.stringify({ configFile: getConfigPath() }) : getConfigPath(),
			)
		})
}
