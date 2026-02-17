import type { Command } from 'commander'
import { formatTable } from '../core/formatter.js'
import { getProviders } from '../core/router.js'
import type { GlobalOptions } from '../types.js'

export function registerSourcesCommand(program: Command): void {
	program
		.command('sources')
		.description('List data sources, capabilities, and status')
		.action(async () => {
			const opts = program.opts<GlobalOptions>()
			const providers = getProviders()

			const rows = providers.map((p) => {
				const windowMs = p.rateLimits.windowMs
				const unit = windowMs < 2000 ? 'sec' : windowMs < 120_000 ? 'min' : 'day'
				const rateStr = `${p.rateLimits.maxRequests}/${unit}`
				return [
					p.name,
					p.isEnabled() ? 'enabled' : 'disabled',
					p.requiresKey ? (p.isEnabled() ? 'configured' : 'missing') : 'none',
					p.capabilities.join(', '),
					rateStr,
				]
			})

			console.log(
				formatTable(
					['Source', 'Status', 'API Key', 'Categories', 'Rate Limit'],
					rows,
					opts.format,
				),
			)
		})
}
