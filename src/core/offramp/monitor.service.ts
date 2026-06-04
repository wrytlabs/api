import {
	Injectable,
	Logger,
	OnModuleInit,
	Controller,
	Post,
	Req,
	Headers,
	HttpCode,
	HttpStatus,
	UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { createHmac } from 'crypto';
import { formatUnits } from 'viem';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '../database/prisma.service';
import { AlchemyService } from '../../integrations/alchemy/alchemy.service';
import { OffRampRoutesService } from '../../modules/offramp-routes/offramp-routes.service';
import { OffRampExecutionsService } from '../../modules/offramp-executions/offramp-executions.service';
import { getTokenByAddress } from '../../config/tokens.config';
import { OFFRAMP_QUEUE, OffRampJobData } from './offramp.queue';

const CHAIN = 'eth-mainnet';
const CHAIN_ID = 1;

@Injectable()
export class MonitorService implements OnModuleInit {
	private readonly logger = new Logger(MonitorService.name);
	private pollTimer: NodeJS.Timeout | null = null;

	constructor(
		private readonly config: ConfigService,
		private readonly prisma: PrismaService,
		private readonly alchemy: AlchemyService,
		private readonly routes: OffRampRoutesService,
		private readonly executions: OffRampExecutionsService,
		@InjectQueue(OFFRAMP_QUEUE)
		private readonly queue: Queue<OffRampJobData>,
	) {}

	onModuleInit() {
		const mode = this.config.get<string>('MONITOR_MODE', 'polling');
		if (mode === 'polling') {
			const interval = this.config.get<number>(
				'MONITOR_POLL_INTERVAL_MS',
				60_000,
			);
			this.logger.log(
				`Monitor starting in polling mode (interval: ${interval}ms)`,
			);
			this.pollTimer = setInterval(() => this.poll(), interval);
		} else {
			this.logger.log(
				'Monitor starting in webhook mode — waiting for Alchemy events',
			);
		}
	}

	// ---------------------------------------------------------------------------
	// Polling (dev / fallback)
	// ---------------------------------------------------------------------------

	async poll() {
		const active = await this.routes.listActiveSafeAddresses();
		if (!active.length) return;

		this.logger.debug(
			`Polling ${active.length} active Safe(s) for incoming transfers`,
		);

		for (const { routeId, address } of active) {
			try {
				await this.checkSafe(routeId, address);
			} catch (err) {
				this.logger.error(
					`Poll error for Safe ${address}: ${err instanceof Error ? err.message : err}`,
				);
			}
		}
	}

	private async checkSafe(routeId: string, safeAddress: string) {
		const result = await this.alchemy.getTokenTransfersFresh(
			CHAIN,
			safeAddress,
			'to',
			25,
		);

		for (const transfer of result.transfers) {
			if (
				!transfer.to ||
				transfer.to.toLowerCase() !== safeAddress.toLowerCase()
			)
				continue;
			if (!transfer.rawContract.address) continue;

			const token = getTokenByAddress(
				transfer.rawContract.address as `0x${string}`,
				CHAIN_ID,
			);
			if (!token) continue;

			const minRecord = await this.prisma.tokenMinAmount.findUnique({
				where: { symbol: token.symbol },
			});
			const minTriggerAmount = minRecord ? minRecord.minAmount : new Decimal(0);

			// Use raw hex value for lossless precision; float `value` loses wei-level digits
			const rawHex = transfer.rawContract.value;
			const amount = rawHex
				? formatUnits(BigInt(rawHex), token.decimals)
				: (transfer.value ?? 0).toString();

			if (new Decimal(amount).lt(minTriggerAmount)) {
				this.logger.debug(
					`Transfer ${transfer.hash}: amount ${amount} below threshold ${minTriggerAmount} for ${token.symbol} — skipping`,
				);
				continue;
			}

			await this.processTransfer({
				txHash: transfer.hash,
				routeId,
				tokenSymbol: token.symbol,
				tokenAmount: amount,
			});
		}
	}

	// ---------------------------------------------------------------------------
	// Shared processing (used by both polling and webhook)
	// ---------------------------------------------------------------------------

	async processTransfer(params: {
		txHash: string;
		routeId: string;
		tokenSymbol: string;
		tokenAmount: string;
	}) {
		// De-duplication: skip if already processed as a deposit
		const existing = await this.executions.findByDepositTxHash(
			params.txHash,
		);
		if (existing) return;

		// Skip if this tx is the on-chain output of a conversion (e.g. 1inch swap landing in Safe)
		const isConversionOutput = await this.prisma.offRampExecution.findFirst(
			{
				where: { conversionTxHash: params.txHash },
			},
		);
		if (isConversionOutput) return;

		const route = await this.prisma.offRampRoute.findUnique({
			where: { id: params.routeId },
			select: { userId: true },
		});
		if (!route) return;

		this.logger.log(
			`New deposit detected — route: ${params.routeId}, token: ${params.tokenSymbol}, amount: ${params.tokenAmount}, tx: ${params.txHash}`,
		);

		const execution = await this.executions.create({
			routeId: params.routeId,
			userId: route.userId,
			depositTokenSymbol: params.tokenSymbol,
			depositTokenAmount: params.tokenAmount,
			depositTxHash: params.txHash,
		});

		await this.queue.add(OFFRAMP_QUEUE, { executionId: execution.id });

		this.logger.log(`Execution ${execution.id} queued for processing`);
	}

	onModuleDestroy() {
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
	}
}

// ---------------------------------------------------------------------------
// Webhook controller (prod) — co-located to keep monitoring logic together
// ---------------------------------------------------------------------------

@Controller('monitor')
export class MonitorController {
	private readonly logger = new Logger(MonitorController.name);

	constructor(
		private readonly config: ConfigService,
		private readonly monitor: MonitorService,
		private readonly routes: OffRampRoutesService,
		private readonly alchemy: AlchemyService,
	) {}

	@Post('webhook')
	@HttpCode(HttpStatus.OK)
	async handleWebhook(
		@Req() req: any,
		@Headers('x-alchemy-signature') signature: string,
	) {
		const webhookSecret = this.config.get<string>('ALCHEMY_WEBHOOK_SECRET');
		if (!webhookSecret)
			throw new UnauthorizedException('Webhook secret not configured');

		const rawBody = JSON.stringify(req.body);
		const expected = createHmac('sha256', webhookSecret)
			.update(rawBody)
			.digest('hex');
		if (signature !== expected)
			throw new UnauthorizedException('Invalid webhook signature');

		const { event } = req.body;
		if (!event?.activity?.length) return { ok: true };

		const activeRoutes = await this.routes.listActiveSafeAddresses();
		const safeAddressMap = new Map(
			activeRoutes.map((r) => [r.address.toLowerCase(), r]),
		);

		for (const activity of event.activity) {
			if (activity.category !== 'erc20') continue;
			const toAddress = activity.toAddress?.toLowerCase();
			if (!toAddress) continue;

			const route = safeAddressMap.get(toAddress);
			if (!route) continue;

			const token = activity.asset as string;
			const rawHex = activity.rawContract?.rawValue;
			const decimals: number | undefined = activity.rawContract?.decimals;
			const amount =
				rawHex != null && decimals != null
					? formatUnits(BigInt(rawHex), decimals)
					: (activity.value ?? 0).toString();

			await this.monitor.processTransfer({
				txHash: activity.hash,
				routeId: route.routeId,
				tokenSymbol: token,
				tokenAmount: amount,
			});
		}

		return { ok: true };
	}
}
