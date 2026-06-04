import {
	CanActivate,
	ExecutionContext,
	ForbiddenException,
	Injectable,
	NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../core/database/prisma.service';

/**
 * Validates the X-Namespace-Id header and ensures the authenticated user is
 * a member of that namespace. Sets request.namespace on success.
 *
 * Use on namespace-scoped routes:
 *   @UseGuards(NamespaceGuard)
 */
@Injectable()
export class NamespaceGuard implements CanActivate {
	constructor(private readonly prisma: PrismaService) {}

	async canActivate(context: ExecutionContext): Promise<boolean> {
		const request = context.switchToHttp().getRequest();
		const namespaceId: string | undefined = request.headers['x-namespace-id'];

		if (!namespaceId) {
			throw new ForbiddenException('X-Namespace-Id header is required');
		}

		const namespace = await this.prisma.namespace.findUnique({
			where: { id: namespaceId },
		});
		if (!namespace) throw new NotFoundException('Namespace not found');

		const userId: string = request.user?.id;
		if (!userId) throw new ForbiddenException('Authenticated user required');

		const member = await this.prisma.namespaceMember.findUnique({
			where: { namespaceId_userId: { namespaceId, userId } },
		});
		if (!member) throw new ForbiddenException('Not a member of this namespace');

		request.namespace = { ...namespace, telegramGroupId: namespace.telegramGroupId?.toString() ?? null };
		request.namespaceMember = member;
		return true;
	}
}
