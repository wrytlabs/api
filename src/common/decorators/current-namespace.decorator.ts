import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Namespace } from '@prisma/client';

export const CurrentNamespace = createParamDecorator(
	(_data: unknown, ctx: ExecutionContext): Namespace => {
		const request = ctx.switchToHttp().getRequest();
		return request.namespace;
	},
);
