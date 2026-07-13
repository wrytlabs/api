import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../core/database/prisma.service';
import { nanoid } from 'nanoid';
import { getAddress, verifyMessage } from 'viem';
import { signJwt } from '../../common/utils/jwt.util';
import { WalletAuthRequestEvent } from '../../common/events/wallet.events';
import { CreateLinkTokenDto } from './dto/create-link-token.dto';
import { WalletChallengeDto } from './dto/wallet-challenge.dto';
import { WalletSigninDto } from './dto/wallet-signin.dto';

@Injectable()
export class UserWalletsService {
  private readonly logger = new Logger(UserWalletsService.name);

  private readonly LINK_TOKEN_LENGTH = 24;
  private readonly LINK_TOKEN_EXPIRY_MINUTES = 15;
  private readonly CHALLENGE_EXPIRY_MINUTES = 10;
  private readonly SESSION_EXPIRY_MINUTES = 5;
  private readonly JWT_EXPIRY_SECONDS = 12 * 3600; // 12 hours

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  private get jwtSecret(): string {
    return this.configService.get<string>('JWT_SECRET')!;
  }

  private checksum(address: string): string {
    try {
      return getAddress(address);
    } catch {
      throw new BadRequestException('Invalid Ethereum address');
    }
  }

  // ---------------------------------------------------------------------------
  // Link token (reverse magic key: app → Telegram)
  // ---------------------------------------------------------------------------

  /**
   * Returns the deterministic ownership message that the frontend must sign
   * before creating a link token. The message embeds the address so the
   * backend can verify it matches the submitted address.
   */
  getLinkMessage(address: string, issuedAt = new Date()): string {
    const expires = new Date(issuedAt.getTime() + this.LINK_TOKEN_EXPIRY_MINUTES * 60 * 1000);
    return (
      `Link wallet to Wrytes\n\n` +
      `Address: ${address}\n` +
      `Issued: ${issuedAt.toISOString()}\n` +
      `Expires: ${expires.toISOString()}\n\n` +
      `By signing this message you confirm ownership of this wallet.`
    );
  }

  /**
   * Parse and strictly validate the link ownership message.
   * Rebuilds the expected string from the embedded timestamps and compares
   * character-for-character — prevents signing arbitrary messages.
   */
  private validateLinkMessage(message: string, address: string): void {
    // Extract Issued and Expires lines
    const issuedMatch = message.match(/^Issued: (.+)$/m);
    const expiresMatch = message.match(/^Expires: (.+)$/m);

    if (!issuedMatch || !expiresMatch) {
      throw new BadRequestException('Malformed link message: missing Issued/Expires fields');
    }

    const issuedAt = new Date(issuedMatch[1].trim());
    const expiresAt = new Date(expiresMatch[1].trim());

    if (isNaN(issuedAt.getTime()) || isNaN(expiresAt.getTime())) {
      throw new BadRequestException('Malformed link message: invalid timestamps');
    }

    // Expires must be in the future
    if (expiresAt <= new Date()) {
      throw new BadRequestException('Link message has expired');
    }

    // Expires must not be more than LINK_TOKEN_EXPIRY_MINUTES + 1 min ahead of Issued
    // (prevents backdating Issued to extend validity)
    const maxWindow = (this.LINK_TOKEN_EXPIRY_MINUTES + 1) * 60 * 1000;
    if (expiresAt.getTime() - issuedAt.getTime() > maxWindow) {
      throw new BadRequestException('Link message expiry window is too large');
    }

    // Issued must not be more than 5 minutes in the past (replay protection)
    const fiveMinutes = 5 * 60 * 1000;
    if (Date.now() - issuedAt.getTime() > fiveMinutes + maxWindow) {
      throw new BadRequestException('Link message is too old');
    }

    // Rebuild the expected message and compare exactly
    const expected = this.getLinkMessage(address, issuedAt);
    if (message !== expected) {
      throw new BadRequestException('Link message does not match the required format');
    }
  }

  async createLinkToken(dto: CreateLinkTokenDto): Promise<{ token: string; expiresAt: Date }> {
    const address = this.checksum(dto.address);

    // Validate message structure before touching the signature
    this.validateLinkMessage(dto.message, address);

    const isValid = await verifyMessage({
      address: address as `0x${string}`,
      message: dto.message,
      signature: dto.signature as `0x${string}`,
    }).catch(() => false);

    if (!isValid) throw new UnauthorizedException('Invalid wallet signature');

    const existing = await this.prisma.userWallet.findUnique({ where: { address } });
    if (existing?.isActive) throw new ConflictException('Wallet already linked to an account');

    const token = nanoid(this.LINK_TOKEN_LENGTH);
    const expiresAt = new Date();
    expiresAt.setMinutes(expiresAt.getMinutes() + this.LINK_TOKEN_EXPIRY_MINUTES);

    await this.prisma.walletLinkToken.create({
      data: { token, walletAddress: address, expiresAt },
    });

    this.logger.log(`Link token created for ${address}`);
    return { token, expiresAt };
  }

  async getLinkTokenStatus(token: string): Promise<{
    status: 'pending' | 'linked' | 'expired' | 'invalid';
    walletAddress?: string;
    linkedAt?: Date;
  }> {
    const record = await this.prisma.walletLinkToken.findUnique({ where: { token } });
    if (!record) return { status: 'invalid' };
    if (!record.usedAt && record.expiresAt < new Date()) {
      return { status: 'expired', walletAddress: record.walletAddress };
    }
    if (!record.usedAt) return { status: 'pending', walletAddress: record.walletAddress };

    const wallet = await this.prisma.userWallet.findUnique({
      where: { address: record.walletAddress },
    });
    return {
      status: 'linked',
      walletAddress: record.walletAddress,
      linkedAt: wallet?.createdAt,
    };
  }

  /** Called by the Telegram /link <token> command handler. */
  async consumeLinkToken(
    token: string,
    telegramId: bigint,
  ): Promise<{ address: string }> {
    const record = await this.prisma.walletLinkToken.findUnique({ where: { token } });
    if (!record) throw new NotFoundException('Invalid link token');
    if (record.usedAt) throw new BadRequestException('Token already used');
    if (record.expiresAt < new Date()) throw new BadRequestException('Token expired');

    const user = await this.prisma.user.findUnique({ where: { telegramId } });
    if (!user) throw new NotFoundException('No account found. Send /start to register first.');

    const address = record.walletAddress;

    const existing = await this.prisma.userWallet.findUnique({ where: { address } });
    if (existing && existing.userId !== user.id) {
      throw new ConflictException('Wallet already linked to a different account');
    }

    await this.prisma.$transaction([
      this.prisma.walletLinkToken.update({
        where: { id: record.id },
        data: { usedAt: new Date() },
      }),
      this.prisma.userWallet.upsert({
        where: { address },
        update: { isActive: true, userId: user.id },
        create: { userId: user.id, address },
      }),
    ]);

    this.logger.log(`Wallet ${address} linked to user ${user.id}`);
    return { address };
  }

  // ---------------------------------------------------------------------------
  // Wallet sign-in (JWT via Telegram 2FA)
  // ---------------------------------------------------------------------------

  async createChallenge(
    dto: WalletChallengeDto,
  ): Promise<{ nonce: string; message: string; expiresAt: Date }> {
    const address = this.checksum(dto.address);

    const wallet = await this.prisma.userWallet.findUnique({ where: { address } });
    if (!wallet?.isActive) {
      throw new NotFoundException(
        'Wallet not linked to any account. Link it via Telegram first.',
      );
    }

    const nonce = nanoid(16);
    const issuedAt = new Date();
    const expiresAt = new Date();
    expiresAt.setMinutes(expiresAt.getMinutes() + this.CHALLENGE_EXPIRY_MINUTES);

    const message =
      `Wrytes Sign-In\n\n` +
      `Wallet: ${address}\n` +
      `Nonce: ${nonce}\n` +
      `Issued: ${issuedAt.toISOString()}\n` +
      `Expires: ${expiresAt.toISOString()}\n\n` +
      `Sign this message to authenticate with Wrytes.`;

    await this.prisma.walletAuthChallenge.create({
      data: { address, nonce, message, expiresAt },
    });

    return { nonce, message, expiresAt };
  }

  async initiateSignin(
    dto: WalletSigninDto,
  ): Promise<{ sessionId: string; expiresAt: Date }> {
    const address = this.checksum(dto.address);

    const isValid = await verifyMessage({
      address: address as `0x${string}`,
      message: dto.message,
      signature: dto.signature as `0x${string}`,
    }).catch(() => false);

    if (!isValid) throw new UnauthorizedException('Invalid wallet signature');

    const challenge = await this.prisma.walletAuthChallenge.findFirst({
      where: { address, message: dto.message, expiresAt: { gt: new Date() } },
    });
    if (!challenge) throw new UnauthorizedException('Challenge not found or expired');

    // Consume the challenge immediately (one-time use)
    await this.prisma.walletAuthChallenge.delete({ where: { id: challenge.id } });

    const wallet = await this.prisma.userWallet.findUnique({
      where: { address },
      include: { user: true },
    });
    if (!wallet?.isActive) throw new UnauthorizedException('Wallet not linked');

    const { user } = wallet;
    const expiresAt = new Date();
    expiresAt.setMinutes(expiresAt.getMinutes() + this.SESSION_EXPIRY_MINUTES);

    const session = await this.prisma.walletAuthSession.create({
      data: {
        walletAddress: address,
        userId: user.id,
        telegramChatId: user.telegramId,
        expiresAt,
      },
    });

    this.eventEmitter.emit(
      'wallet.auth.request',
      new WalletAuthRequestEvent(
        session.sessionId,
        address,
        Number(user.telegramId),
        expiresAt,
      ),
    );

    this.logger.log(`Auth session ${session.sessionId} created for ${address} — awaiting TG approval`);
    return { sessionId: session.sessionId, expiresAt };
  }

  async pollSession(sessionId: string): Promise<{
    status: 'pending' | 'approved' | 'denied' | 'expired';
    jwt?: string;
  }> {
    const session = await this.prisma.walletAuthSession.findUnique({ where: { sessionId } });
    if (!session) return { status: 'expired' };

    if (session.status === 'PENDING' && session.expiresAt < new Date()) {
      await this.prisma.walletAuthSession
        .update({ where: { id: session.id }, data: { status: 'EXPIRED' } })
        .catch(() => null);
      return { status: 'expired' };
    }

    switch (session.status) {
      case 'APPROVED': return { status: 'approved', jwt: session.jwt ?? undefined };
      case 'DENIED':   return { status: 'denied' };
      case 'EXPIRED':  return { status: 'expired' };
      default:         return { status: 'pending' };
    }
  }

  /** Called by the Telegram ✅ Allow callback. */
  async approveSession(sessionId: string, telegramId: bigint): Promise<void> {
    const session = await this.prisma.walletAuthSession.findUnique({
      where: { sessionId },
      include: { user: true },
    });

    if (!session) throw new NotFoundException('Session not found');
    if (session.user.telegramId !== telegramId) throw new UnauthorizedException('Not your session');
    if (session.status !== 'PENDING') throw new BadRequestException('Session already resolved');
    if (session.expiresAt < new Date()) {
      await this.prisma.walletAuthSession.update({
        where: { id: session.id },
        data: { status: 'EXPIRED' },
      });
      throw new BadRequestException('Session expired');
    }

    const jwt = signJwt(
      { sub: session.userId, wallet: session.walletAddress },
      this.jwtSecret,
      this.JWT_EXPIRY_SECONDS,
    );

    await this.prisma.walletAuthSession.update({
      where: { id: session.id },
      data: { status: 'APPROVED', jwt },
    });

    this.logger.log(`Auth session ${sessionId} approved`);
  }

  /** Called by the Telegram ❌ Deny callback. */
  async denySession(sessionId: string, telegramId: bigint): Promise<void> {
    const session = await this.prisma.walletAuthSession.findUnique({
      where: { sessionId },
      include: { user: true },
    });

    if (!session) throw new NotFoundException('Session not found');
    if (session.user.telegramId !== telegramId) throw new UnauthorizedException('Not your session');
    if (session.status !== 'PENDING') throw new BadRequestException('Session already resolved');

    await this.prisma.walletAuthSession.update({
      where: { id: session.id },
      data: { status: 'DENIED' },
    });

    this.logger.log(`Auth session ${sessionId} denied`);
  }

  async setSessionTelegramMsgId(sessionId: string, messageId: number): Promise<void> {
    await this.prisma.walletAuthSession
      .updateMany({ where: { sessionId }, data: { telegramMsgId: messageId } })
      .catch(() => null);
  }

  async getSessionTelegramInfo(
    sessionId: string,
  ): Promise<{ chatId: number; msgId: number | null } | null> {
    const session = await this.prisma.walletAuthSession.findUnique({
      where: { sessionId },
      select: { telegramChatId: true, telegramMsgId: true },
    });
    if (!session) return null;
    return { chatId: Number(session.telegramChatId), msgId: session.telegramMsgId };
  }

  // ---------------------------------------------------------------------------
  // Wallet management (protected endpoints)
  // ---------------------------------------------------------------------------

  async listWallets(userId: string) {
    return this.prisma.userWallet.findMany({
      where: { userId, isActive: true },
      select: { id: true, address: true, label: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async unlinkWallet(userId: string, address: string): Promise<void> {
    const checksumAddress = this.checksum(address);
    const wallet = await this.prisma.userWallet.findFirst({
      where: { userId, address: checksumAddress },
    });
    if (!wallet) throw new NotFoundException('Wallet not found');
    await this.prisma.userWallet.update({
      where: { id: wallet.id },
      data: { isActive: false },
    });
  }

  async updateWalletLabel(userId: string, address: string, label: string | null): Promise<void> {
    const checksumAddress = this.checksum(address);
    const wallet = await this.prisma.userWallet.findFirst({
      where: { userId, address: checksumAddress, isActive: true },
    });
    if (!wallet) throw new NotFoundException('Wallet not found');
    await this.prisma.userWallet.update({ where: { id: wallet.id }, data: { label } });
  }
}
