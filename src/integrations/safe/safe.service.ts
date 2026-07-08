import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import Safe from '@safe-global/protocol-kit';
import { encodeFunctionData, erc20Abi, getAddress, keccak256, toHex } from 'viem';
import type { Address } from 'viem';
import { PrismaService } from '../../core/database/prisma.service';
import { AdminNotificationEvent } from '../../common/events/notification.events';
import { WalletService } from '../wallet/wallet.service';
import { WalletViemService } from '../wallet/wallet.viem.service';
import { ChainId, ALCHEMY_CHAIN_SLUGS } from '../wallet/wallet.types';

const L1_CHAIN_IDS: ChainId[] = [1];

export interface MemberWalletInfo {
	userId: string;
	telegramHandle: string | null;
	wallets: string[];
}

@Injectable()
export class SafeService {
	private readonly logger = new Logger(SafeService.name);

	constructor(
		private readonly prisma: PrismaService,
		private readonly wallet: WalletService,
		private readonly viemService: WalletViemService,
		private readonly configService: ConfigService,
		private readonly eventEmitter: EventEmitter2,
	) {}

	private deriveSaltNonce(namespaceId: string, chainId: ChainId, label: string): string {
		const hash = keccak256(toHex(`${namespaceId}:${chainId}:${label}`));
		return BigInt(hash).toString();
	}

	private rpcUrl(chainId: ChainId): string {
		const apiKey = this.configService.get<string>('alchemy.apiKey', '');
		return `https://${ALCHEMY_CHAIN_SLUGS[chainId]}.g.alchemy.com/v2/${apiKey}`;
	}

	private async initSdkForAddress(safeAddress: string, chainId: ChainId): Promise<Safe> {
		const privateKey = process.env.WALLET_PRIVATE_KEY;
		if (!privateKey) throw new Error('WALLET_PRIVATE_KEY is required');
		return Safe.init({ provider: this.rpcUrl(chainId), signer: privateKey, safeAddress });
	}

	private async initSdk(saltNonce: string, chainId: ChainId, owners: string[]): Promise<Safe> {
		const privateKey = process.env.WALLET_PRIVATE_KEY;
		if (!privateKey) throw new Error('WALLET_PRIVATE_KEY is required');

		return Safe.init({
			provider: this.rpcUrl(chainId),
			signer: privateKey,
			isL1SafeSingleton: L1_CHAIN_IDS.includes(chainId),
			predictedSafe: {
				safeAccountConfig: {
					owners,
					threshold: 1,
				},
				safeDeploymentConfig: {
					saltNonce,
					safeVersion: '1.4.1',
				},
			},
		});
	}

	/**
	 * Predict or retrieve a Safe for a namespace.
	 * memberOwners: wallet addresses to add as owners alongside the operator wallet.
	 * Operator wallet is always included so the platform can relay transactions.
	 */
	async getOrCreate(namespaceId: string, chainId: ChainId, label = 'primary', memberOwners: string[] = []) {
		const existing = await this.prisma.safeWallet.findUnique({
			where: { namespaceId_chainId_label: { namespaceId, chainId, label } },
		});
		if (existing) return existing;

		const operatorAddress = this.wallet.requireAccount().address;
		const allOwners = Array.from(new Set([...memberOwners, operatorAddress]));

		const saltNonce = this.deriveSaltNonce(namespaceId, chainId, label);
		const sdk = await this.initSdk(saltNonce, chainId, allOwners);
		const address = await sdk.getAddress();

		this.logger.log(`Predicted Safe for namespace ${namespaceId} on chain ${chainId} [${label}]: ${address} (owners: ${allOwners.length})`);

		return this.prisma.safeWallet.create({
			data: { namespaceId, chainId, label, address, saltNonce, owners: allOwners },
		});
	}

	async listWallets(namespaceId: string, chainId?: ChainId) {
		return this.prisma.safeWallet.findMany({
			where: { namespaceId, ...(chainId ? { chainId } : {}) },
			orderBy: { createdAt: 'asc' },
		});
	}

	async ensureDeployed(namespaceId: string, chainId: ChainId, label = 'primary'): Promise<void> {
		const safeWallet = await this.getOrCreate(namespaceId, chainId, label);
		if (safeWallet.deployed) return;

		// Fall back to operator-only for Safes created before the owners column was added
		const owners = safeWallet.owners.length > 0
			? safeWallet.owners
			: [this.wallet.requireAccount().address];

		const sdk = await this.initSdk(safeWallet.saltNonce, chainId, owners);
		const isDeployed = await sdk.isSafeDeployed();

		if (isDeployed) {
			await this.prisma.safeWallet.update({
				where: { id: safeWallet.id },
				data: { deployed: true, deployedAt: new Date() },
			});
			return;
		}

		this.logger.log(`Deploying Safe ${safeWallet.address} for namespace ${namespaceId} on chain ${chainId}`);

		const deployTx = await sdk.createSafeDeploymentTransaction();
		const gasFees = await this.viemService.conservativeGasFees(chainId);
		const hash = await this.wallet.requireClient(chainId).sendTransaction({
			account: this.wallet.requireAccount(),
			chain: null,
			to: deployTx.to as `0x${string}`,
			data: deployTx.data as `0x${string}`,
			value: BigInt(deployTx.value ?? 0),
			...gasFees,
		});

		await this.viemService.getClient(chainId).waitForTransactionReceipt({ hash });

		await this.prisma.safeWallet.update({
			where: { id: safeWallet.id },
			data: { deployed: true, deployedAt: new Date() },
		});

		this.logger.log(`Safe deployed at ${safeWallet.address} (tx: ${hash})`);

		this.eventEmitter.emit(
			'notification.admin',
			new AdminNotificationEvent(
				'Safe Deployed',
				`Namespace \`${namespaceId}\` deployed a Safe on chain ${chainId} \\[${label}\\]\nAddress: \`${safeWallet.address}\`\nTx: \`${hash}\``,
				'success',
			),
		);
	}

	/** Returns linked wallet addresses for all members of a namespace, grouped by member. */
	async getMemberWalletAddresses(namespaceId: string): Promise<MemberWalletInfo[]> {
		const members = await this.prisma.namespaceMember.findMany({
			where: { namespaceId },
			include: {
				user: {
					select: {
						id: true,
						telegramHandle: true,
						userWallets: {
							where: { isActive: true },
							select: { address: true },
						},
					},
				},
			},
		});
		return members.map(m => ({
			userId: m.userId,
			telegramHandle: m.user.telegramHandle ?? null,
			wallets: m.user.userWallets.map(w => w.address),
		}));
	}

	/** Fetches the owners and threshold of a deployed Safe from the chain. */
	async getOwners(address: string, chainId: ChainId): Promise<{ owners: string[]; threshold: number }> {
		const checksummed = getAddress(address);
		const sdk = await this.initSdkForAddress(checksummed, chainId);
		const [owners, threshold] = await Promise.all([sdk.getOwners(), sdk.getThreshold()]);
		return { owners, threshold };
	}

	/** Links an already-deployed external Safe to a namespace. */
	async linkExisting(namespaceId: string, address: string, chainId: ChainId, label: string) {
		const checksummed = getAddress(address);

		const sdk = await this.initSdkForAddress(checksummed, chainId);
		const isDeployed = await sdk.isSafeDeployed();
		if (!isDeployed) throw new BadRequestException('Address is not a deployed Safe');

		try {
			return await this.prisma.safeWallet.create({
				data: {
					namespaceId,
					address: checksummed,
					chainId,
					label,
					saltNonce: 'external',
					deployed: true,
					deployedAt: new Date(),
				},
			});
		} catch (err: unknown) {
			const code = (err as { code?: string }).code;
			if (code === 'P2002') throw new ConflictException(`A Safe with label "${label}" already exists for this namespace on this chain`);
			throw err;
		}
	}

	/**
	 * Execute an arbitrary transaction from a Safe wallet.
	 * The operator account (WALLET_PRIVATE_KEY) signs and executes the Safe transaction.
	 * Returns the on-chain transaction hash.
	 */
	async executeRaw(
		safeWalletId: string,
		to: Address,
		data: `0x${string}`,
		value: bigint,
	): Promise<`0x${string}`> {
		return this.executeManyRaw(safeWalletId, [{ to, data, value }]);
	}

	/**
	 * Batch multiple transactions into a single Safe transaction via MultiSend.
	 * All calls are atomic — if any reverts, the entire batch reverts.
	 * Returns the on-chain transaction hash.
	 */
	async executeManyRaw(
		safeWalletId: string,
		txs: Array<{ to: Address; data: `0x${string}`; value: bigint }>,
	): Promise<`0x${string}`> {
		if (txs.length === 0) throw new Error('executeManyRaw requires at least one transaction');

		const safeWallet = await this.prisma.safeWallet.findUnique({ where: { id: safeWalletId } });
		if (!safeWallet) throw new NotFoundException(`Safe wallet ${safeWalletId} not found`);

		const chainId = safeWallet.chainId as ChainId;
		const sdk = await this.initSdkForAddress(safeWallet.address, chainId);

		const safeTx = await sdk.createTransaction({
			transactions: txs.map(({ to, data, value }) => ({ to, data, value: value.toString() })),
		});

		const signedTx = await sdk.signTransaction(safeTx);
		const gasFees = await this.viemService.conservativeGasFees(chainId);
		const result = await sdk.executeTransaction(signedTx, {
			maxFeePerGas: gasFees.maxFeePerGas.toString(),
			maxPriorityFeePerGas: gasFees.maxPriorityFeePerGas.toString(),
		});
		const txHash = result.hash as `0x${string}`;

		this.logger.log(`Safe batch tx executed — safe: ${safeWallet.address}, ops: ${txs.length}, tx: ${txHash}`);

		await this.viemService.getClient(chainId).waitForTransactionReceipt({ hash: txHash });

		return txHash;
	}

	/**
	 * Transfer an ERC-20 token out of a Safe wallet to an external address.
	 * The operator account (WALLET_PRIVATE_KEY) signs and executes the Safe transaction.
	 * Returns the on-chain transaction hash.
	 */
	async executeTransfer(
		safeWalletId: string,
		tokenAddress: Address,
		toAddress: Address,
		amount: bigint,
	): Promise<`0x${string}`> {
		const safeWallet = await this.prisma.safeWallet.findUnique({ where: { id: safeWalletId } });
		if (!safeWallet) throw new NotFoundException(`Safe wallet ${safeWalletId} not found`);

		const chainId = safeWallet.chainId as ChainId;
		const sdk = await this.initSdkForAddress(safeWallet.address, chainId);

		const data = encodeFunctionData({
			abi: erc20Abi,
			functionName: 'transfer',
			args: [toAddress, amount],
		});

		const safeTx = await sdk.createTransaction({
			transactions: [{ to: tokenAddress, value: '0', data }],
		});

		const signedTx = await sdk.signTransaction(safeTx);
		const gasFees = await this.viemService.conservativeGasFees(chainId);
		const result = await sdk.executeTransaction(signedTx, {
			maxFeePerGas: gasFees.maxFeePerGas.toString(),
			maxPriorityFeePerGas: gasFees.maxPriorityFeePerGas.toString(),
		});
		const txHash = result.hash as `0x${string}`;

		this.logger.log(`Safe transfer executed — safe: ${safeWallet.address}, token: ${tokenAddress}, to: ${toAddress}, tx: ${txHash}`);

		await this.viemService.getClient(chainId).waitForTransactionReceipt({ hash: txHash });

		return txHash;
	}
}
