import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from '../../core/database/prisma.service';
import { TelegramService } from '../../integrations/telegram/telegram.service';
import { AdminNotificationEvent, NotificationEvent, NotificationLevel } from '../events/notification.events';

const LEVEL_EMOJI: Record<NotificationLevel, string> = {
  info: 'ℹ️',
  success: '✅',
  warning: '⚠️',
  error: '❌',
};

@Injectable()
export class NotificationListener {
  private readonly logger = new Logger(NotificationListener.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly telegramService: TelegramService,
  ) {}

  @OnEvent('notification')
  async handleNotification(event: NotificationEvent) {
    const emoji = LEVEL_EMOJI[event.level];
    const message = `${emoji} *${event.title}*\n\n${event.message}`;

    const chatId = await this.resolveChatId(event.namespaceId);
    if (!chatId) return;

    await this.telegramService.sendMarkdownMessage(chatId, message).catch((err) => {
      this.logger.error(`Failed to send notification for namespace ${event.namespaceId}: ${err.message}`);
    });
  }

  @OnEvent('notification.admin')
  async handleAdminNotification(event: AdminNotificationEvent) {
    const adminScopes = await this.prisma.userScope.findMany({
      where: { scopeKey: 'ADMIN' },
      include: { user: true },
    });

    const emoji = LEVEL_EMOJI[event.level];
    const message = `${emoji} *${event.title}*\n\n${event.message}`;

    await Promise.all(
      adminScopes.map(({ user }) =>
        this.telegramService.sendMarkdownMessage(Number(user.telegramId), message).catch((err) => {
          this.logger.error(`Failed to send admin notification to user ${user.id}: ${err.message}`);
        }),
      ),
    );
  }

  /**
   * Resolves the Telegram chat ID for a namespace notification.
   * - If the namespace has a telegramGroupId, use the group chat.
   * - Otherwise fall back to the OWNER's private chat (legacy/unmigrated namespaces).
   */
  private async resolveChatId(namespaceId: string): Promise<number | null> {
    const namespace = await this.prisma.namespace.findUnique({
      where: { id: namespaceId },
      include: {
        members: {
          where: { role: 'OWNER' },
          include: { user: { select: { telegramId: true, notificationsEnabled: true } } },
          take: 1,
        },
      },
    });

    if (!namespace) return null;

    if (namespace.telegramGroupId) {
      return Number(namespace.telegramGroupId);
    }

    // Legacy namespace: fall back to owner's private chat
    const owner = namespace.members[0]?.user;
    if (!owner || !owner.notificationsEnabled) return null;
    return Number(owner.telegramId);
  }
}
