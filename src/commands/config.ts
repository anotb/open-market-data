import type { Command } from 'commander'
import { getConfigPath, loadConfig, saveConfig } from '../core/config.js'

export function registerConfigCommand(program: Command): void {
	const config = program.command('config').description('Manage configuration')

	config
		.command('show')
		.description('Show current configuration')
		.action(() => {
			const cfg = loadConfig()
			console.log(`Config file: ${getConfigPath()}\n`)
			console.log(
				JSON.stringify(
					{
						...cfg,
						fredApiKey: cfg.fredApiKey ? '***configured***' : undefined,
						coingeckoApiKey: cfg.coingeckoApiKey ? '***configured***' : undefined,
						finnhubApiKey: cfg.finnhubApiKey ? '***configured***' : undefined,
						alphaVantageApiKey: cfg.alphaVantageApiKey ? '***configured***' : undefined,
					},
					null,
					2,
				),
			)
		})

	config
		.command('set <key> <value>')
		.description('Set a configuration value')
		.action((key: string, value: string) => {
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
			saveConfig({ [key]: value })
			console.log(`Set ${key} = ${key.includes('Key') ? '***' : value}`)
		})

	config
		.command('path')
		.description('Show config file path')
		.action(() => {
			console.log(getConfigPath())
		})
}
