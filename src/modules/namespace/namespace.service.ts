import {
	ForbiddenException,
	Injectable,
	NotFoundException,
} from '@nestjs/common';
import { NamespaceRole } from '@prisma/client';
import { PrismaService } from '../../core/database/prisma.service';

// BigInt telegramGroupId cannot be JSON-serialised by default — convert to string.
function serializeNamespace<T extends { telegramGroupId: bigint | null }>(ns: T) {
	return { ...ns, telegramGroupId: ns.telegramGroupId?.toString() ?? null }
}

@Injectable()
export class NamespaceService {
	constructor(private readonly prisma: PrismaService) {}

	async list(userId: string) {
		const memberships = await this.prisma.namespaceMember.findMany({
			where: { userId },
			include: {
				namespace: {
					include: {
						members: { include: { user: { select: { id: true, telegramHandle: true } } } },
						safeWallets: { select: { id: true, address: true, chainId: true, label: true, deployed: true } },
					},
				},
			},
		});
		return memberships.map((m) => ({ ...serializeNamespace(m.namespace), role: m.role }));
	}

	async get(namespaceId: string, userId: string) {
		await this.assertMember(namespaceId, userId);
		const ns = await this.prisma.namespace.findUniqueOrThrow({
			where: { id: namespaceId },
			include: {
				members: { include: { user: { select: { id: true, telegramHandle: true } } } },
				safeWallets: { select: { id: true, address: true, chainId: true, label: true, deployed: true } },
			},
		});
		return serializeNamespace(ns);
	}

	async update(namespaceId: string, userId: string, name: string) {
		await this.assertOwner(namespaceId, userId);
		const ns = await this.prisma.namespace.update({
			where: { id: namespaceId },
			data: { name },
		});
		return serializeNamespace(ns);
	}

	async addMember(
		namespaceId: string,
		actorUserId: string,
		targetUserId: string,
		role: NamespaceRole = NamespaceRole.MEMBER,
	) {
		await this.assertOwner(namespaceId, actorUserId);
		return this.prisma.namespaceMember.upsert({
			where: { namespaceId_userId: { namespaceId, userId: targetUserId } },
			create: { namespaceId, userId: targetUserId, role },
			update: { role },
		});
	}

	async removeMember(namespaceId: string, actorUserId: string, targetUserId: string) {
		await this.assertOwner(namespaceId, actorUserId);
		await this.prisma.namespaceMember.delete({
			where: { namespaceId_userId: { namespaceId, userId: targetUserId } },
		});
	}

	async getByTelegramGroupId(telegramGroupId: bigint) {
		return this.prisma.namespace.findUnique({
			where: { telegramGroupId },
			include: { members: true },
		});
	}

	async createFromTelegramGroup(
		telegramGroupId: bigint,
		groupName: string,
		ownerUserId: string,
	) {
		return this.prisma.$transaction(async (tx) => {
			const namespace = await tx.namespace.create({
				data: { name: groupName, telegramGroupId },
			});
			await tx.namespaceMember.create({
				data: { namespaceId: namespace.id, userId: ownerUserId, role: NamespaceRole.OWNER },
			});
			return serializeNamespace(namespace);
		});
	}

	async linkTelegramGroup(namespaceId: string, userId: string, telegramGroupId: bigint) {
		await this.assertOwner(namespaceId, userId);
		const ns = await this.prisma.namespace.update({
			where: { id: namespaceId },
			data: { telegramGroupId },
		});
		return serializeNamespace(ns);
	}

	async isMember(namespaceId: string, userId: string): Promise<boolean> {
		const member = await this.prisma.namespaceMember.findUnique({
			where: { namespaceId_userId: { namespaceId, userId } },
		});
		return !!member;
	}

	private async assertMember(namespaceId: string, userId: string) {
		const ok = await this.isMember(namespaceId, userId);
		if (!ok) throw new ForbiddenException('Not a member of this namespace');
	}

	private async assertOwner(namespaceId: string, userId: string) {
		const member = await this.prisma.namespaceMember.findUnique({
			where: { namespaceId_userId: { namespaceId, userId } },
		});
		if (!member) throw new ForbiddenException('Not a member of this namespace');
		if (member.role !== NamespaceRole.OWNER) throw new ForbiddenException('Owner role required');
	}
}
