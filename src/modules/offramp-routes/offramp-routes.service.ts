import { Injectable, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { IsEnum, IsOptional, IsString } from 'class-validator';
import { FiatCurrency, OffRampRouteStatus } from '@prisma/client';
import { PrismaService } from '../../core/database/prisma.service';
import { SafeService } from '../../integrations/safe/safe.service';

export class CreateRouteDto {
  @IsString()
  label!: string;

  @IsEnum(FiatCurrency)
  targetCurrency!: FiatCurrency;

  @IsString()
  bankAccountId!: string;
}

export class UpdateRouteDto {
  @IsOptional()
  @IsString()
  label?: string;
}

@Injectable()
export class OffRampRoutesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly safe: SafeService,
  ) {}

  async create(namespaceId: string, dto: CreateRouteDto) {
    const bankAccount = await this.prisma.bankAccount.findFirst({
      where: { id: dto.bankAccountId, namespaceId },
    });
    if (!bankAccount) throw new NotFoundException('Bank account not found');

    if (bankAccount.currency !== dto.targetCurrency) {
      throw new BadRequestException(
        `Bank account currency (${bankAccount.currency}) must match targetCurrency (${dto.targetCurrency})`,
      );
    }

    const existing = await this.prisma.offRampRoute.findUnique({
      where: { namespaceId_label: { namespaceId, label: dto.label } },
    });
    if (existing) throw new ConflictException(`Route with label "${dto.label}" already exists`);

    const safeWallet = await this.safe.getOrCreate(namespaceId, 1, `offramp:${dto.bankAccountId}:${dto.targetCurrency}`);

    const route = await this.prisma.offRampRoute.create({
      data: {
        namespaceId,
        label: dto.label,
        safeWalletId: safeWallet.id,
        targetCurrency: dto.targetCurrency,
        bankAccountId: dto.bankAccountId,
      },
      include: { safeWallet: true, bankAccount: { select: { currency: true, label: true } } },
    });

    return { ...route, depositAddress: safeWallet.address };
  }

  async list(namespaceId: string) {
    const routes = await this.prisma.offRampRoute.findMany({
      where: { namespaceId },
      include: {
        safeWallet: { select: { address: true, deployed: true } },
        bankAccount: { select: { currency: true, label: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return routes.map((r) => ({ ...r, depositAddress: r.safeWallet.address }));
  }

  async get(id: string, namespaceId: string) {
    const route = await this.prisma.offRampRoute.findFirst({
      where: { id, namespaceId },
      include: {
        safeWallet: { select: { address: true, deployed: true, chainId: true } },
        bankAccount: { select: { currency: true, label: true } },
      },
    });
    if (!route) throw new NotFoundException('Route not found');
    return { ...route, depositAddress: route.safeWallet.address };
  }

  async pause(id: string, namespaceId: string) {
    const route = await this.prisma.offRampRoute.findFirst({ where: { id, namespaceId } });
    if (!route) throw new NotFoundException('Route not found');
    if (route.status === OffRampRouteStatus.PAUSED) throw new BadRequestException('Route is already paused');
    return this.prisma.offRampRoute.update({ where: { id }, data: { status: OffRampRouteStatus.PAUSED } });
  }

  async activate(id: string, namespaceId: string) {
    const route = await this.prisma.offRampRoute.findFirst({ where: { id, namespaceId } });
    if (!route) throw new NotFoundException('Route not found');
    if (route.status === OffRampRouteStatus.ACTIVE) throw new BadRequestException('Route is already active');
    return this.prisma.offRampRoute.update({ where: { id }, data: { status: OffRampRouteStatus.ACTIVE } });
  }

  async delete(id: string) {
    const route = await this.prisma.offRampRoute.findUnique({ where: { id } });
    if (!route) throw new NotFoundException('Route not found');
    return this.prisma.offRampRoute.delete({ where: { id } });
  }

  async update(id: string, namespaceId: string, dto: UpdateRouteDto) {
    const route = await this.prisma.offRampRoute.findFirst({ where: { id, namespaceId } });
    if (!route) throw new NotFoundException('Route not found');

    if (dto.label && dto.label !== route.label) {
      const conflict = await this.prisma.offRampRoute.findUnique({
        where: { namespaceId_label: { namespaceId, label: dto.label } },
      });
      if (conflict) throw new ConflictException(`Route with label "${dto.label}" already exists`);
    }

    return this.prisma.offRampRoute.update({
      where: { id },
      data: { ...(dto.label !== undefined && { label: dto.label }) },
    });
  }

  async findActiveForSafe(safeAddress: string) {
    return this.prisma.offRampRoute.findFirst({
      where: {
        status: OffRampRouteStatus.ACTIVE,
        safeWallet: { address: safeAddress },
      },
      include: {
        safeWallet: true,
        bankAccount: true,
      },
    });
  }

  async listActiveSafeAddresses(): Promise<{ routeId: string; address: string; targetCurrency: FiatCurrency }[]> {
    const routes = await this.prisma.offRampRoute.findMany({
      where: { status: OffRampRouteStatus.ACTIVE },
      select: {
        id: true,
        targetCurrency: true,
        safeWallet: { select: { address: true } },
      },
    });
    return routes.map((r) => ({
      routeId: r.id,
      address: r.safeWallet.address,
      targetCurrency: r.targetCurrency,
    }));
  }
}
