import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../core/database/prisma.service';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { verifyJwt } from '../utils/jwt.util';
import * as bcrypt from 'bcrypt';

/**
 * Global authentication guard that accepts either:
 *   - `Authorization: Bearer <jwt>`  (wallet sign-in, approved via Telegram 2FA)
 *   - `X-API-Key: rw_prod_<keyId>.<secret>`  (classic Telegram magic-link flow)
 *
 * JWT is tried first. If absent the guard falls back to the API key.
 * Public routes (decorated with @Public()) bypass both checks.
 */
@Injectable()
export class CombinedAuthGuard implements CanActivate {
  private readonly logger = new Logger(CombinedAuthGuard.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    // Non-HTTP contexts (Telegraf bot handlers) bypass HTTP auth
    if (context.getType() !== 'http') return true;

    const request = context.switchToHttp().getRequest();
    const authHeader: string | undefined = request.headers['authorization'];
    const apiKeyHeader: string | undefined = request.headers['x-api-key'];

    // ── JWT ─────────────────────────────────────────────────────────────────
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      return this.authenticateJwt(token, request);
    }

    // ── API Key ──────────────────────────────────────────────────────────────
    if (apiKeyHeader) {
      return this.authenticateApiKey(apiKeyHeader, request);
    }

    throw new UnauthorizedException(
      'Authentication required: provide Bearer token or X-API-Key header',
    );
  }

  private async authenticateJwt(token: string, request: any): Promise<boolean> {
    const secret = this.config.get<string>('JWT_SECRET')!;

    let payload: ReturnType<typeof verifyJwt>;
    try {
      payload = verifyJwt(token, secret);
    } catch (err) {
      throw new UnauthorizedException(`JWT invalid: ${(err as Error).message}`);
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      include: { scopes: true },
    });
    if (!user) throw new UnauthorizedException('User not found');

    request.user = user;
    request.userScopes = user.scopes.map((s) => s.scopeKey);
    request.authMethod = 'jwt';
    return true;
  }

  private async authenticateApiKey(header: string, request: any): Promise<boolean> {
    const match = header.match(/^rw_prod_([a-zA-Z0-9_-]+)\.([a-zA-Z0-9_-]+)$/);
    if (!match) throw new UnauthorizedException('Invalid API key format');

    const [, keyId, secret] = match;
    const apiKey = await this.prisma.apiKey.findUnique({
      where: { keyId },
      include: { user: { include: { scopes: true } } },
    });

    if (!apiKey) throw new UnauthorizedException('Invalid API key');
    if (apiKey.revokedAt) throw new UnauthorizedException('API key has been revoked');
    if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
      throw new UnauthorizedException('API key has expired');
    }

    const isValid = await bcrypt.compare(secret, apiKey.secretHash);
    if (!isValid) throw new UnauthorizedException('Invalid API key');

    this.prisma.apiKey
      .update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } })
      .catch((err) => this.logger.error(`Failed to update lastUsedAt: ${err.message}`));

    request.user = apiKey.user;
    request.userScopes = apiKey.user.scopes.map((s) => s.scopeKey);
    request.authMethod = 'api-key';
    request.apiKey = apiKey;
    return true;
  }
}
