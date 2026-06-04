import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Job, Queue } from 'bullmq';
import { parseUnits, formatUnits, getAddress } from 'viem';
import type { Address } from 'viem';
import { FiatCurrency } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { SafeService } from '../../integrations/safe/safe.service';
import {
	WalletViemService,
	GasTooHighError,
} from '../../integrations/wallet/wallet.viem.service';
import { OneInchService } from '../../integrations/oneinch/oneinch.service';
import { KrakenDeposit } from '../../integrations/kraken/kraken.deposit';
import { KrakenOrders } from '../../integrations/kraken/kraken.orders';
import { KrakenWithdraw } from '../../integrations/kraken/kraken.withdraw';
import {
	NotificationEvent,
	AdminNotificationEvent,
} from '../../common/events/notification.events';
import { ENABLED_TOKENS } from '../../config/tokens.config';
import { ConversionStrategyRegistry } from './strategies/conversion-strategy.registry';
import {
	OFFRAMP_QUEUE,
	OffRampJobData,
	KRAKEN_DEPOSIT_ASSET,
	KRAKEN_DEPOSIT_METHOD_HINT,
	KRAKEN_FIAT_ASSET,
	KRAKEN_WITHDRAW_KEY_ENV,
	krakenPairFor,
} from './offramp.queue';

const OPERATOR = 'operator';
const ENQUEUE_NEXT_DELAY_MS = 60_000; // 1 minutes
const DEPOSIT_POLL_DELAY_MS = 5 * 60_000; // 5 minutes
const DEPOSIT_POLL_MAX_ATTEMPTS = 1_440; // 5 days
const WITHDRAWAL_POLL_DELAY_MS = 5 * 60_000; // 5 minutes
const WITHDRAWAL_POLL_MAX_ATTEMPTS = 1_440; // 5 days
const GAS_RETRY_DELAY_MS = 5 * 60_000; // 5 minutes
const GAS_RETRY_MAX_ATTEMPTS = 1_440; // 5 days

@Processor(OFFRAMP_QUEUE)
export class OffRampProcessor extends WorkerHost {
	private readonly logger = new Logger(OffRampProcessor.name);

	constructor(
		private readonly prisma: PrismaService,
		private readonly safe: SafeService,
		private readonly viem: WalletViemService,
		private readonly oneinch: OneInchService,
		private readonly registry: ConversionStrategyRegistry,
		private readonly krakenDeposit: KrakenDeposit,
		private readonly krakenOrders: KrakenOrders,
		private readonly krakenWithdraw: KrakenWithdraw,
		private readonly configService: ConfigService,
		private readonly eventEmitter: EventEmitter2,
		@InjectQueue(OFFRAMP_QUEUE)
		private readonly queue: Queue<OffRampJobData>,
	) {
		super();
	}

	async process(job: Job<OffRampJobData>): Promise<void> {
		const { executionId } = job.data;

		const execution = await this.prisma.offRampExecution.findUnique({
			where: { id: executionId },
			include: {
				route: { include: { safeWallet: true, bankAccount: true } },
			},
		});

		if (!execution) {
			this.logger.warn(`Execution ${executionId} not found — skipping`);
			return;
		}

		try {
			switch (execution.status) {
				case 'DETECTED':
					await this.handleDetected(execution);
					break;
				case 'CONVERTING': {
					const strategy = this.registry.get(
						execution.depositTokenSymbol,
					);
					if (!strategy)
						throw new Error(
							`No strategy found for ${execution.depositTokenSymbol} in CONVERTING state`,
						);
					await this.handleConvert(
						execution,
						strategy,
						job.data.gasRetryAttempt ?? 0,
					);
					break;
				}
				case 'TRANSFERRING':
					if (execution.transferTxHash) {
						await this.handleWaitDeposit(
							execution,
							job.data.pollAttempt ?? 0,
						);
					} else {
						await this.handleTransfer(
							execution,
							job.data.gasRetryAttempt ?? 0,
						);
					}
					break;
				case 'DEPOSITED':
					await this.handleSell(execution);
					break;
				case 'SOLD':
					await this.handleWithdraw(execution);
					break;
				case 'WITHDRAWING':
					await this.handleCheckWithdrawal(
						execution,
						job.data.pollAttempt ?? 0,
					);
					break;
				default:
					this.logger.warn(
						`Execution ${executionId} in terminal status ${execution.status} — skipping`,
					);
			}
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			this.logger.error(
				`Execution ${executionId} failed at ${execution.status}: ${error}`,
			);
			await this.prisma.offRampExecution.update({
				where: { id: executionId },
				data: { status: 'FAILED', error },
			});
			this.notifyUser(
				execution.namespaceId ?? execution.userId,
				'Off-ramp failed',
				`Your off-ramp could not be completed: ${error}`,
				'error',
			);
			this.notifyAdmin(
				'Off-ramp execution failed',
				`Execution \`${executionId}\` failed at status \`${execution.status}\`\n\nError: ${error}`,
				'error',
			);
		}
	}

	// ---------------------------------------------------------------------------
	// Step 1a DETECTED — route to conversion or direct transfer
	// ---------------------------------------------------------------------------
	private async handleDetected(execution: any) {
		this.notifyUser(
			execution.namespaceId ?? execution.userId,
			'Received',
			`${execution.depositTokenAmount} ${execution.depositTokenSymbol} received.`,
		);
		const strategy = this.registry.get(execution.depositTokenSymbol);
		if (strategy) {
			await this.prisma.offRampExecution.update({
				where: { id: execution.id },
				data: { status: 'CONVERTING' },
			});
			await this.handleConvert(execution, strategy, 0);
		} else {
			// Direct transfer — Kraken receives the same token as the deposit
			await this.prisma.offRampExecution.update({
				where: { id: execution.id },
				data: {
					status: 'TRANSFERRING',
					krakenTokenSymbol: execution.depositTokenSymbol,
					krakenTokenAmount: execution.depositTokenAmount,
				},
			});
			await this.handleTransfer(execution, 0);
		}
	}

	// ---------------------------------------------------------------------------
	// Step 1b CONVERTING — run pre-deposit conversion strategy (unwrap, swap, redeem, …)
	// ---------------------------------------------------------------------------
	private async handleConvert(
		execution: any,
		strategy: any,
		gasRetryAttempt: number,
	) {
		const { route } = execution;
		const { safeWallet } = route;
		const chainId = safeWallet.chainId;

		const tokenConfig = ENABLED_TOKENS.find(
			(t) => t.symbol === execution.depositTokenSymbol,
		);
		if (!tokenConfig)
			throw new Error(
				`Token ${execution.depositTokenSymbol} not found in config`,
			);

		const amount = parseUnits(
			execution.depositTokenAmount.toString(),
			tokenConfig.decimals,
		);

		try {
			await this.viem.conservativeGasFees(chainId);

			// If the strategy outputs a Kraken-mapped token, route the swap directly to the Kraken
			// deposit address — this saves one on-chain transfer from the Safe.
			let krakenRecipient: Address | undefined;
			if (
				strategy.outputSymbol &&
				KRAKEN_DEPOSIT_ASSET[strategy.outputSymbol]
			) {
				const depositAddress = await this.resolveKrakenDepositAddress(
					strategy.outputSymbol,
				);
				krakenRecipient = getAddress(depositAddress) as Address;
				this.logger.log(
					`Routing ${strategy.outputSymbol} swap output directly to Kraken deposit address ${depositAddress}`,
				);
			}

			this.logger.log(
				`Converting ${execution.depositTokenAmount} ${execution.depositTokenSymbol} via strategy (safe: ${safeWallet.address})`,
			);

			await this.safe.ensureDeployed(
				execution.namespaceId ?? execution.userId,
				chainId,
				safeWallet.label,
			);

			const result = await strategy.execute(
				{ safe: this.safe, oneinch: this.oneinch, viem: this.viem },
				safeWallet.id,
				getAddress(safeWallet.address) as Address,
				chainId,
				amount,
				krakenRecipient,
			);

			const outputDecimals =
				result.tokenSymbol === 'ETH'
					? 18
					: (ENABLED_TOKENS.find(
							(t) => t.symbol === result.tokenSymbol,
						)?.decimals ?? 18);
			const outputAmount = formatUnits(result.amount, outputDecimals);

			await this.prisma.offRampExecution.update({
				where: { id: execution.id },
				data: {
					conversionTxHash: result.txHash,
					krakenTokenSymbol: result.tokenSymbol,
					krakenTokenAmount: outputAmount,
				},
			});

			this.logger.log(
				`Conversion complete: ${execution.depositTokenSymbol} → ${result.tokenSymbol} (${outputAmount}) tx: ${result.txHash}`,
			);
			this.notifyUser(
				execution.namespaceId ?? execution.userId,
				'Converted',
				`${execution.depositTokenAmount} ${execution.depositTokenSymbol} → ${outputAmount} ${result.tokenSymbol}`,
			);

			if (krakenRecipient) {
				// Funds landed directly at Kraken — no separate Safe→Kraken transfer needed
				await this.prisma.offRampExecution.update({
					where: { id: execution.id },
					data: {
						status: 'TRANSFERRING',
						transferTxHash: result.txHash,
					},
				});
				await this.enqueueNext(execution.id, ENQUEUE_NEXT_DELAY_MS);
			} else {
				// Funds are still in the Safe — proceed to transfer (status stays CONVERTING until handleTransfer sets TRANSFERRING)
				const updated = await this.prisma.offRampExecution.findUnique({
					where: { id: execution.id },
					include: {
						route: {
							include: { safeWallet: true, bankAccount: true },
						},
					},
				});
				await this.handleTransfer(updated, gasRetryAttempt);
			}
		} catch (err) {
			if (err instanceof GasTooHighError) {
				await this.retryOnGas(
					execution.id,
					gasRetryAttempt,
					err.message,
				);
				return;
			}
			throw err;
		}
	}

	// ---------------------------------------------------------------------------
	// Step 2 TRANSFERRING — execute Safe → Kraken transfer (ERC-20 or native ETH)
	// ---------------------------------------------------------------------------
	private async handleTransfer(execution: any, gasRetryAttempt: number) {
		const { route } = execution;
		const { safeWallet } = route;

		// Use post-conversion token if available, otherwise the originally received token
		const krakenSymbol: string =
			execution.krakenTokenSymbol ?? execution.depositTokenSymbol;
		const krakenAmount: string =
			execution.krakenTokenAmount?.toString() ??
			execution.depositTokenAmount.toString();

		try {
			await this.viem.conservativeGasFees(safeWallet.chainId);

			const depositAddress =
				await this.resolveKrakenDepositAddress(krakenSymbol);

			this.logger.log(
				`Transferring ${krakenAmount} ${krakenSymbol} from Safe ${safeWallet.address} to Kraken ${depositAddress}`,
			);

			// ensureDeployed is a no-op when already deployed; skipped when conversion already ran it
			await this.safe.ensureDeployed(
				execution.namespaceId ?? execution.userId,
				safeWallet.chainId,
				safeWallet.label,
			);

			await this.prisma.offRampExecution.update({
				where: { id: execution.id },
				data: { status: 'TRANSFERRING' },
			});

			let txHash: `0x${string}`;

			if (krakenSymbol === 'ETH') {
				const amount = parseUnits(krakenAmount, 18);
				txHash = await this.safe.executeRaw(
					safeWallet.id,
					getAddress(depositAddress) as Address,
					'0x',
					amount,
				);
			} else {
				const tokenConfig = ENABLED_TOKENS.find(
					(t) => t.symbol === krakenSymbol,
				);
				if (!tokenConfig?.addresses[safeWallet.chainId])
					throw new Error(
						`Token ${krakenSymbol} not found in config`,
					);
				const tokenAddress = getAddress(
					tokenConfig.addresses[safeWallet.chainId]!,
				) as Address;
				const amount = parseUnits(krakenAmount, tokenConfig.decimals);
				txHash = await this.safe.executeTransfer(
					safeWallet.id,
					tokenAddress,
					getAddress(depositAddress) as Address,
					amount,
				);
			}

			await this.prisma.offRampExecution.update({
				where: { id: execution.id },
				data: { transferTxHash: txHash },
			});

			await this.enqueueNext(execution.id, ENQUEUE_NEXT_DELAY_MS);
		} catch (err) {
			if (err instanceof GasTooHighError) {
				await this.retryOnGas(
					execution.id,
					gasRetryAttempt,
					err.message,
				);
				return;
			}
			throw err;
		}
	}

	// ---------------------------------------------------------------------------
	// Step 2 TRANSFERRING → DEPOSITED
	// Poll Kraken until deposit confirmed
	// ---------------------------------------------------------------------------
	private async handleWaitDeposit(execution: any, attempt: number) {
		if (attempt >= DEPOSIT_POLL_MAX_ATTEMPTS) {
			throw new Error(
				'Kraken deposit not confirmed after maximum polling attempts (2h)',
			);
		}

		const krakenSymbol =
			execution.krakenTokenSymbol ?? execution.depositTokenSymbol;
		const krakenAsset = KRAKEN_DEPOSIT_ASSET[krakenSymbol];
		const statusRes = await this.krakenDeposit.getStatus(OPERATOR, {
			asset: krakenAsset,
		});
		if (statusRes.error?.length)
			throw new Error(
				`Kraken deposit status error: ${statusRes.error.join(', ')}`,
			);

		const match = statusRes.result.find(
			(d) =>
				d.txid === execution.transferTxHash && d.status === 'Success',
		);

		if (!match) {
			this.logger.log(
				`Execution ${execution.id}: waiting for Kraken deposit confirmation (attempt ${attempt + 1}/${DEPOSIT_POLL_MAX_ATTEMPTS})`,
			);
			await this.enqueueNext(
				execution.id,
				DEPOSIT_POLL_DELAY_MS,
				attempt + 1,
			);
			return;
		}

		await this.prisma.offRampExecution.update({
			where: { id: execution.id },
			data: { status: 'DEPOSITED', krakenDepositRef: match.refid },
		});

		this.notifyUser(
			execution.namespaceId ?? execution.userId,
			'Arrived at exchange',
			`${execution.depositTokenAmount} ${execution.depositTokenSymbol} confirmed on Kraken — swapping to fiat.`,
		);

		await this.enqueueNext(execution.id, ENQUEUE_NEXT_DELAY_MS / 20); // fast execution on kraken
	}

	// ---------------------------------------------------------------------------
	// Step 3 DEPOSITED → SOLD
	// Place market sell order and wait for fill
	// ---------------------------------------------------------------------------
	private async handleSell(execution: any) {
		const { route } = execution;
		const krakenSymbol =
			execution.krakenTokenSymbol ?? execution.depositTokenSymbol;
		const krakenAmount =
			execution.krakenTokenAmount?.toString() ??
			execution.depositTokenAmount.toString();
		const pair = krakenPairFor(krakenSymbol, route.targetCurrency);
		if (!pair)
			throw new Error(
				`No Kraken trading pair for ${krakenSymbol}/${route.targetCurrency}`,
			);

		await this.prisma.offRampExecution.update({
			where: { id: execution.id },
			data: { status: 'SELLING' },
		});

		this.logger.log(
			`Placing sell order — pair: ${pair}, volume: ${krakenAmount}`,
		);

		const { krakenOrderId, order: filledOrder } =
			await this.krakenOrders.placeAndWait(OPERATOR, {
				ordertype: 'market',
				type: 'sell',
				pair,
				volume: krakenAmount,
			});

		const krakenFiatAmount = filledOrder.cost;

		await this.prisma.offRampExecution.update({
			where: { id: execution.id },
			data: {
				status: 'SOLD',
				krakenOrderId,
				krakenPair: pair,
				krakenFiatCurrency: route.targetCurrency,
				krakenFiatAmount,
				krakenTradeFee: filledOrder.fee,
			},
		});

		this.notifyUser(
			execution.namespaceId ?? execution.userId,
			'Swapped to fiat',
			`${execution.depositTokenAmount} ${execution.depositTokenSymbol} → ${krakenFiatAmount} ${route.targetCurrency} — initiating bank withdrawal.`,
		);

		await this.enqueueNext(execution.id, ENQUEUE_NEXT_DELAY_MS / 20);
	}

	// ---------------------------------------------------------------------------
	// Step 4 SOLD → WITHDRAWING
	// Initiate fiat withdrawal to Wrytes AG bank account
	// ---------------------------------------------------------------------------
	private async handleWithdraw(execution: any) {
		const { route } = execution;
		const currency = route.targetCurrency as FiatCurrency;

		const fiatAsset = KRAKEN_FIAT_ASSET[currency];
		const withdrawKeyEnv = KRAKEN_WITHDRAW_KEY_ENV[currency];

		if (!fiatAsset || !withdrawKeyEnv) {
			throw new Error(
				`Currency ${currency} is not supported for fiat withdrawal`,
			);
		}

		const withdrawKey = this.configService.get<string>(withdrawKeyEnv);
		if (!withdrawKey) {
			throw new Error(
				`${withdrawKeyEnv} is not configured — cannot initiate fiat withdrawal`,
			);
		}

		const grossAmount = Number(execution.krakenFiatAmount);
		const tradeFee = Number(execution.krakenTradeFee ?? 0);
		const withdrawAmount = (grossAmount - tradeFee).toFixed(8);

		const withdrawRes = await this.krakenWithdraw.withdraw(OPERATOR, {
			asset: fiatAsset,
			key: withdrawKey,
			amount: withdrawAmount,
		});

		if (withdrawRes.error?.length)
			throw new Error(
				`Kraken withdrawal error: ${withdrawRes.error.join(', ')}`,
			);

		await this.prisma.offRampExecution.update({
			where: { id: execution.id },
			data: {
				status: 'WITHDRAWING',
				krakenWithdrawalId: withdrawRes.result.refid,
			},
		});

		await this.enqueueNext(execution.id, ENQUEUE_NEXT_DELAY_MS / 20);
	}

	// ---------------------------------------------------------------------------
	// Step 5 WITHDRAWING → COMPLETED
	// Poll until withdrawal succeeds
	// ---------------------------------------------------------------------------
	private async handleCheckWithdrawal(execution: any, attempt: number) {
		if (attempt >= WITHDRAWAL_POLL_MAX_ATTEMPTS) {
			throw new Error(
				'Fiat withdrawal not confirmed after maximum polling attempts (1h)',
			);
		}

		const currency = execution.route.targetCurrency as FiatCurrency;
		const fiatAsset = KRAKEN_FIAT_ASSET[currency] ?? currency;

		const statusRes = await this.krakenWithdraw.withdrawStatus(OPERATOR, {
			asset: fiatAsset,
		});
		if (statusRes.error?.length)
			throw new Error(
				`Kraken withdrawal status error: ${statusRes.error.join(', ')}`,
			);

		const match = statusRes.result.find(
			(w) =>
				w.refid === execution.krakenWithdrawalId &&
				w.status === 'Success',
		);

		if (!match) {
			this.logger.log(
				`Execution ${execution.id}: waiting for fiat withdrawal (attempt ${attempt + 1}/${WITHDRAWAL_POLL_MAX_ATTEMPTS})`,
			);
			await this.enqueueNext(
				execution.id,
				WITHDRAWAL_POLL_DELAY_MS,
				attempt + 1,
			);
			return;
		}

		const route = execution.route;
		const bankAccount = route.bankAccount;

		await this.prisma.offRampExecution.update({
			where: { id: execution.id },
			data: {
				status: 'PENDING_BANK_TRANSFER',
				krakenWithdrawAmount: match.amount,
				krakenWithdrawFee: match.fee,
			},
		});

		this.notifyUser(
			execution.namespaceId ?? execution.userId,
			'Payment pending',
			`${match.amount} ${currency} (fee: ${match.fee} ${currency}) is being transferred to your bank account.`,
		);

		this.notifyAdmin(
			'Payment pending review',
			`Execution \`${execution.id}\`\nAmount: *${match.amount} ${currency}* (fee: ${match.fee} ${currency})\nUser: \`${execution.userId}\`\nBank: ${bankAccount.label} — \`${bankAccount.iban}\`\n\nMark as settled: \`PATCH /offramp/executions/${execution.id}/settle\``,
			'warning',
		);

		this.logger.log(
			`Execution ${execution.id} PENDING_BANK_TRANSFER — awaiting manual PostFinance transfer`,
		);
	}

	// ---------------------------------------------------------------------------
	// Helpers
	// ---------------------------------------------------------------------------
	private async retryOnGas(
		executionId: string,
		attempt: number,
		message: string,
	) {
		const next = attempt + 1;
		if (next > GAS_RETRY_MAX_ATTEMPTS) {
			this.logger.error(
				`Execution ${executionId}: gas remained too high after 5 days — failing`,
			);
			throw new Error(
				`Gas too high after ${GAS_RETRY_MAX_ATTEMPTS} attempts: ${message}`,
			);
		}
		this.logger.warn(
			`Execution ${executionId}: ${message} (attempt ${next}/${GAS_RETRY_MAX_ATTEMPTS})`,
		);
		await this.queue.add(
			OFFRAMP_QUEUE,
			{ executionId, gasRetryAttempt: next },
			{ delay: GAS_RETRY_DELAY_MS },
		);
	}

	private async resolveKrakenDepositAddress(
		krakenSymbol: string,
	): Promise<string> {
		const krakenAsset = KRAKEN_DEPOSIT_ASSET[krakenSymbol];
		if (!krakenAsset) {
			throw new Error(
				`Token ${krakenSymbol} has no Kraken deposit mapping. Add a conversion strategy or update KRAKEN_DEPOSIT_ASSET.`,
			);
		}

		const methodHint = KRAKEN_DEPOSIT_METHOD_HINT[krakenSymbol];
		const methodsRes = await this.krakenDeposit.getMethods(OPERATOR, {
			asset: krakenAsset,
		});
		if (methodsRes.error?.length)
			throw new Error(
				`Kraken deposit methods error: ${methodsRes.error.join(', ')}`,
			);

		this.logger.log(
			`Kraken deposit methods for ${krakenAsset}: ${methodsRes.result.map((m) => m.method).join(', ')}`,
		);

		const method = methodsRes.result.find((m) =>
			m.method.toUpperCase().includes(methodHint.toUpperCase()),
		);
		if (!method)
			throw new Error(
				`No deposit method found for ${krakenAsset}. Available: ${methodsRes.result.map((m) => m.method).join(', ')}`,
			);

		const addrRes = await this.krakenDeposit.getAddresses(OPERATOR, {
			asset: krakenAsset,
			method: method.method,
		});
		if (addrRes.error?.length)
			throw new Error(
				`Kraken deposit address error: ${addrRes.error.join(', ')}`,
			);

		const address = addrRes.result[0]?.address;
		if (!address) throw new Error('No Kraken deposit address available');
		return address;
	}

	private async enqueueNext(
		executionId: string,
		delayMs: number,
		pollAttempt = 0,
	) {
		await this.queue.add(
			OFFRAMP_QUEUE,
			{ executionId, pollAttempt },
			{ delay: delayMs },
		);
	}

	private notifyUser(
		namespaceId: string | null | undefined,
		title: string,
		message: string,
		level: 'info' | 'success' | 'warning' | 'error' = 'info',
	) {
		if (!namespaceId) return;
		this.eventEmitter.emit(
			'notification',
			new NotificationEvent(namespaceId, title, message, level),
		);
	}

	private notifyAdmin(
		title: string,
		message: string,
		level: 'info' | 'success' | 'warning' | 'error' = 'info',
	) {
		this.eventEmitter.emit(
			'notification.admin',
			new AdminNotificationEvent(title, message, level),
		);
	}
}
