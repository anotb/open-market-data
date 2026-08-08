import type { Command } from 'commander'
import { formatTable } from '../core/formatter.js'
import { checkProviderHealth } from '../core/health.js'
import { getProviders } from '../core/router.js'
import type { GlobalOptions } from '../types.js'

interface DoctorOptions {
	strict?: boolean
	timeout: string
}

export function registerDoctorCommand(program: Command): void {
	program
		.command('doctor [source]')
		.description('Probe provider connectivity and validate representative responses')
		.option('--strict', 'exit non-zero when any provider is not healthy')
		.option('--timeout <ms>', 'per-provider timeout in milliseconds', '15000')
		.action(async (source: string | undefined, commandOptions: DoctorOptions) => {
			const opts = program.opts<GlobalOptions>()
			const allProviders = getProviders()
			const selectedSource = (source ?? opts.source)?.trim().toLowerCase()
			const providers = selectedSource
				? allProviders.filter((provider) => provider.name === selectedSource)
				: allProviders
			if (providers.length === 0) {
				throw new Error(
					`Unknown provider "${selectedSource}". Run "omd sources" to list providers.`,
				)
			}

			const timeoutMs = Number.parseInt(commandOptions.timeout, 10)
			if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60_000) {
				throw new Error('--timeout must be between 1000 and 60000 milliseconds')
			}

			const results = await checkProviderHealth(providers, { timeoutMs })
			if (opts.format === 'json') {
				console.log(JSON.stringify(results, null, 2))
			} else {
				const rows = results.map((result) => [
					result.name,
					result.status,
					result.latencyMs ? `${result.latencyMs} ms` : '',
					result.probe ?? '',
					result.message ?? '',
					result.recommendedAction ?? '',
				])
				console.log(
					formatTable(
						['Provider', 'Status', 'Latency', 'Probe', 'Details', 'Recommended action'],
						rows,
						opts.format,
					),
				)
			}

			const failed = results.some((result) =>
				commandOptions.strict ? result.status !== 'ok' : result.status === 'error',
			)
			if (failed) process.exitCode = 1
		})
}
