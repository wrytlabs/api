import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Update, Start, Command, Ctx, InjectBot, Action, On } from 'nestjs-telegraf';
import { Context, Telegraf } from 'telegraf';
import { AuthService } from '../../modules/auth/auth.service';
import { UserWalletsService } from '../../modules/user-wallets/user-wallets.service';
import { NamespaceService } from '../../modules/namespace/namespace.service';
import { TelegramService } from './telegram.service';

@Update()
@Injectable()
export class TelegramUpdate implements OnModuleInit {
  private readonly logger = new Logger(TelegramUpdate.name);

  constructor(
    @InjectBot() private readonly bot: Telegraf,
    private readonly authService: AuthService,
    private readonly userWalletsService: UserWalletsService,
    private readonly namespaceService: NamespaceService,
    private readonly telegramService: TelegramService,
  ) {}

  async onModuleInit() {
    try {
      await this.bot.telegram.setMyCommands([
        { command: 'start', description: 'Register and show available commands' },
        { command: 'me', description: 'Show your account info' },
        { command: 'namespaces', description: 'List your namespaces' },
        { command: 'api_create', description: 'Generate a magic link to create an API key' },
        { command: 'link', description: 'Link a wallet — usage: /link <token>' },
        { command: 'wallets', description: 'List your linked wallets' },
      ]);
    } catch (err) {
      this.logger.warn(`Failed to set bot commands: ${err.message}`);
    }
  }

  // ── /start ──────────────────────────────────────────────────────────────────

  @Start()
  async onStart(@Ctx() ctx: Context) {
    const from = ctx.from;
    if (!from) return;

    const { id: userId, isNew } = await this.authService.getOrCreateUser(
      BigInt(from.id),
      from.username,
    );

    const handle = from.username ? `@${from.username}` : from.first_name;

    const commandList =
      `/me — Show your account info\n` +
      `/namespaces — List your namespaces\n` +
      `/api_create — Generate an API key\n` +
      `/link <token> — Link a wallet from the app\n` +
      `/wallets — List linked wallets`;

    if (isNew) {
      await ctx.reply(
        `Welcome to Wrytes, ${handle}!\n\nYour account has been created.\n\nAvailable commands:\n${commandList}`,
      );
      this.logger.log(`New user registered: ${userId} (${handle})`);
    } else {
      await ctx.reply(`Welcome back, ${handle}!\n\nAvailable commands:\n${commandList}`);
    }
  }

  // ── /me ─────────────────────────────────────────────────────────────────────

  @Command('me')
  async onMe(@Ctx() ctx: Context) {
    const from = ctx.from;
    if (!from) return;

    const user = await this.authService.findUserByTelegramId(BigInt(from.id));
    if (!user) {
      await ctx.reply('You are not registered. Send /start to create an account.');
      return;
    }

    const handle = from.username ? `@${from.username}` : from.first_name;
    const keys = await this.authService.listApiKeys(user.id);
    const wallets = await this.userWalletsService.listWallets(user.id);

    const walletLines =
      wallets.length > 0
        ? wallets
            .map((w: { address: string }) => `  • ${w.address.slice(0, 6)}...${w.address.slice(-4)}`)
            .join('\n')
        : '  None linked yet — use /link <token>';

    await ctx.reply(
      `Account: ${handle}\n` +
        `ID: ${user.id}\n` +
        `API keys: ${keys.length} active\n\n` +
        `Linked wallets:\n${walletLines}\n\n` +
        `Use /api_create to generate a new API key.\n` +
        `Use /link <token> to link a wallet from the app.`,
    );
  }

  // ── /namespaces ─────────────────────────────────────────────────────────────

  @Command('namespaces')
  async onNamespaces(@Ctx() ctx: Context) {
    const from = ctx.from;
    if (!from) return;

    const user = await this.authService.findUserByTelegramId(BigInt(from.id));
    if (!user) {
      await ctx.reply('You are not registered. Send /start to create an account.');
      return;
    }

    const namespaces = await this.namespaceService.list(user.id);

    if (namespaces.length === 0) {
      await ctx.reply(
        'You have no namespaces yet.\n\n' +
          'To create one, add me to a Telegram group. I will automatically create a namespace for that group.',
      );
      return;
    }

    const lines = namespaces.map((ns: any) => {
      const role = ns.role as string;
      const safeCount = ns.safeWallets?.length ?? 0;
      const groupStatus = ns.telegramGroupId
        ? `Group linked (ID: ${ns.telegramGroupId})`
        : '⚠️ No group linked — add me to a TG group';
      return (
        `📦 *${ns.name}*\n` +
        `  Role: ${role}\n` +
        `  ${groupStatus}\n` +
        `  Safe wallets: ${safeCount}`
      );
    });

    await ctx.reply(`Your namespaces:\n\n${lines.join('\n\n')}`, { parse_mode: 'Markdown' });
  }

  // ── /api_create ─────────────────────────────────────────────────────────────

  @Command('api_create')
  async onApiCreate(@Ctx() ctx: Context) {
    const from = ctx.from;
    if (!from) return;

    const user = await this.authService.findUserByTelegramId(BigInt(from.id));
    if (!user) {
      await ctx.reply('You are not registered. Send /start to create an account.');
      return;
    }

    try {
      const { token, expiresAt } = await this.authService.createMagicLink(user.id);
      const appUrl = process.env.APP_URL || 'http://localhost:3000';
      const magicLink = `${appUrl}/auth/api-key?token=${token}`;
      const expiresIn = Math.round((expiresAt.getTime() - Date.now()) / 60000);

      await ctx.reply(
        `Magic link generated!\n\n` +
          `Visit the link below to retrieve your API key:\n${magicLink}\n\n` +
          `Expires in ${expiresIn} minutes. Single use only.`,
      );
    } catch (err) {
      this.logger.error(`Failed to create magic link: ${err.message}`);
      await ctx.reply('Failed to generate magic link. Please try again.');
    }
  }

  // ── /link <token> ───────────────────────────────────────────────────────────

  @Command('link')
  async onLink(@Ctx() ctx: Context) {
    const from = ctx.from;
    if (!from) return;

    const text = (ctx.message as any)?.text as string | undefined;
    const parts = text?.trim().split(/\s+/) ?? [];
    const token = parts[1];

    if (!token) {
      await ctx.reply(
        'Usage: /link <token>\n\nGet your link token from the Wrytes app after connecting your wallet.',
      );
      return;
    }

    try {
      const { address } = await this.userWalletsService.consumeLinkToken(
        token,
        BigInt(from.id),
      );
      const short = `${address.slice(0, 6)}...${address.slice(-4)}`;
      await ctx.reply(
        `✅ Wallet linked successfully!\n\n` +
          `Address: ${short}\n\n` +
          `You can now sign in with this wallet on the Wrytes app.`,
      );
    } catch (err) {
      this.logger.warn(`Link token failed for user ${from.id}: ${err.message}`);
      await ctx.reply(`❌ Failed to link wallet: ${err.message}`);
    }
  }

  // ── /wallets ─────────────────────────────────────────────────────────────────

  @Command('wallets')
  async onWallets(@Ctx() ctx: Context) {
    const from = ctx.from;
    if (!from) return;

    const user = await this.authService.findUserByTelegramId(BigInt(from.id));
    if (!user) {
      await ctx.reply('You are not registered. Send /start first.');
      return;
    }

    const wallets = await this.userWalletsService.listWallets(user.id);

    if (wallets.length === 0) {
      await ctx.reply(
        'No wallets linked yet.\n\nConnect your wallet in the Wrytes app and use /link <token> to link it here.',
      );
      return;
    }

    const lines = wallets
      .map((w: { address: string; label?: string | null }, i: number) => {
        const short = `${w.address.slice(0, 6)}...${w.address.slice(-4)}`;
        const label = w.label ? ` (${w.label})` : '';
        return `${i + 1}. ${short}${label}`;
      })
      .join('\n');

    await ctx.reply(`Your linked wallets:\n\n${lines}`);
  }

  // ── Namespace group events ───────────────────────────────────────────────────

  @On('my_chat_member')
  async onMyChatMember(@Ctx() ctx: Context) {
    const update = (ctx.update as any).my_chat_member;
    if (!update) return;

    const { chat, from, new_chat_member } = update;

    // Only handle being added to a group/supergroup
    if (chat.type !== 'group' && chat.type !== 'supergroup') return;
    if (!['member', 'administrator'].includes(new_chat_member?.status)) return;

    // Ensure the user who added the bot is registered
    const ownerResult = await this.authService.findUserByTelegramId(BigInt(from.id))
      ?? await this.authService.getOrCreateUser(BigInt(from.id), from.username).then(r => ({ id: r.id }));
    const ownerUserId = (ownerResult as { id: string }).id;

    // Check if a namespace already exists for this group
    const existing = await this.namespaceService.getByTelegramGroupId(BigInt(chat.id));
    if (existing) {
      this.logger.log(`Bot added to known namespace group: ${chat.title}`);
      return;
    }

    const namespace = await this.namespaceService.createFromTelegramGroup(
      BigInt(chat.id),
      chat.title ?? `Group ${chat.id}`,
      ownerUserId,
    );

    this.logger.log(`Namespace created from group ${chat.title}: ${namespace.id}`);

    try {
      await ctx.telegram.sendMessage(
        chat.id,
        `✅ *Namespace "${namespace.name}" created!*\n\nThis group is now linked to a Wrytes namespace.\n\nUse the Wrytes app to set up a Safe wallet for this namespace.`,
        { parse_mode: 'Markdown' },
      );
    } catch (err) {
      this.logger.warn(`Failed to send namespace created message: ${err.message}`);
    }
  }

  @On('chat_member')
  async onChatMember(@Ctx() ctx: Context) {
    const update = (ctx.update as any).chat_member;
    if (!update) return;

    const { chat, new_chat_member } = update;

    // Only handle members being added (not removed)
    if (!['member', 'administrator'].includes(new_chat_member?.status)) return;

    const namespace = await this.namespaceService.getByTelegramGroupId(BigInt(chat.id));
    if (!namespace) return;

    const newMemberTgId = new_chat_member.user?.id;
    if (!newMemberTgId || new_chat_member.user?.is_bot) return;

    const newUser = await this.authService.findUserByTelegramId(BigInt(newMemberTgId));
    if (!newUser) return; // User hasn't /start'd the bot yet — will join when they do

    const alreadyMember = await this.namespaceService.isMember(namespace.id, newUser.id);
    if (alreadyMember) return;

    // Find the namespace OWNER to act as actor for addMember
    const ownerMember = namespace.members.find((m: any) => m.role === 'OWNER');
    if (!ownerMember) return;

    try {
      await this.namespaceService.addMember(namespace.id, ownerMember.userId, newUser.id);
      this.logger.log(`Auto-added user ${newUser.id} to namespace ${namespace.id}`);
    } catch (err) {
      this.logger.warn(`Failed to auto-add member to namespace: ${err.message}`);
    }
  }

  // ── Wallet 2FA callbacks ────────────────────────────────────────────────────

  @Action(/^wallet_auth:allow:.+$/)
  async onWalletAuthAllow(@Ctx() ctx: Context) {
    const from = ctx.from;
    if (!from) return;

    const data = (ctx.callbackQuery as any)?.data as string;
    const sessionId = data.split(':')[2];

    try {
      await this.userWalletsService.approveSession(sessionId, BigInt(from.id));

      const info = await this.userWalletsService.getSessionTelegramInfo(sessionId);
      if (info?.msgId) {
        await this.telegramService.editWalletAuthMessage(
          info.chatId,
          info.msgId,
          `✅ *Sign-In Approved*\n\nYour wallet has been authenticated. You can close Telegram.`,
        );
      }

      await ctx.answerCbQuery('Sign-in approved ✅');
    } catch (err) {
      this.logger.warn(`Allow callback failed: ${err.message}`);
      await ctx.answerCbQuery(`Failed: ${err.message}`, { show_alert: true });
    }
  }

  @Action(/^wallet_auth:deny:.+$/)
  async onWalletAuthDeny(@Ctx() ctx: Context) {
    const from = ctx.from;
    if (!from) return;

    const data = (ctx.callbackQuery as any)?.data as string;
    const sessionId = data.split(':')[2];

    try {
      await this.userWalletsService.denySession(sessionId, BigInt(from.id));

      const info = await this.userWalletsService.getSessionTelegramInfo(sessionId);
      if (info?.msgId) {
        await this.telegramService.editWalletAuthMessage(
          info.chatId,
          info.msgId,
          `❌ *Sign-In Denied*\n\nThe wallet sign-in request was rejected.`,
        );
      }

      await ctx.answerCbQuery('Sign-in denied ❌');
    } catch (err) {
      this.logger.warn(`Deny callback failed: ${err.message}`);
      await ctx.answerCbQuery(`Failed: ${err.message}`, { show_alert: true });
    }
  }
}
