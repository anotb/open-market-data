import type { Command } from 'commander'
import { formatTable } from '../core/formatter.js'
import { getRemaining } from '../core/rate-limiter.js'
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
				const remaining = getRemaining(p.name, p.rateLimits)
				const rateStr = `${p.rateLimits.maxRequests}/${p.rateLimits.windowMs < 2000 ? 'sec' : 'min'}`
				return [
					p.name,
					p.isEnabled() ? 'enabled' : 'disabled',
					p.requiresKey ? (p.isEnabled() ? 'configured' : 'missing') : 'none',
					p.capabilities.join(', '),
					rateStr,
					`${remaining}/${p.rateLimits.maxRequests}`,
				]
			})

			console.log(
				formatTable(
					['Source', 'Status', 'API Key', 'Categories', 'Rate Limit', 'Remaining'],
					rows,
					opts.format,
				),
			)
		})
}
