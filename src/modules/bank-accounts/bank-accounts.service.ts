import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { IsEnum, IsOptional, IsString } from 'class-validator';
import { FiatCurrency } from '@prisma/client';
import { PrismaService } from '../../core/database/prisma.service';
import { EncryptionService } from '../../common/encryption/encryption.service';

export class CreateBankAccountDto {
  @IsString()
  iban!: string;

  @IsString()
  bic!: string;

  @IsEnum(FiatCurrency)
  currency!: FiatCurrency;

  @IsOptional()
  @IsString()
  label?: string;
}

export class UpdateBankAccountDto {
  @IsOptional()
  @IsString()
  bic?: string;

  @IsOptional()
  @IsString()
  label?: string;
}

@Injectable()
export class BankAccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
  ) {}

  async create(namespaceId: string, dto: CreateBankAccountDto) {
    const label = dto.label ?? 'default';

    const existing = await this.prisma.bankAccount.findUnique({
      where: { namespaceId_label: { namespaceId, label } },
    });
    if (existing) throw new ConflictException(`Bank account with label "${label}" already exists`);

    const iban = this.encryption.encrypt(dto.iban.replace(/\s/g, '').toUpperCase());
    return this.prisma.bankAccount.create({
      data: {
        namespaceId,
        iban,
        bic: dto.bic.toUpperCase(),
        currency: dto.currency,
        label,
      },
    });
  }

  async list(namespaceId: string) {
    const accounts = await this.prisma.bankAccount.findMany({
      where: { namespaceId },
      orderBy: { createdAt: 'asc' },
    });
    return accounts.map((a) => ({ ...a, iban: this.maskIban(this.encryption.decrypt(a.iban)) }));
  }

  async getDecrypted(id: string, namespaceId: string) {
    const account = await this.prisma.bankAccount.findFirst({ where: { id, namespaceId } });
    if (!account) throw new NotFoundException('Bank account not found');
    return { ...account, iban: this.encryption.decrypt(account.iban) };
  }

  async update(id: string, namespaceId: string, dto: UpdateBankAccountDto) {
    const account = await this.prisma.bankAccount.findFirst({ where: { id, namespaceId } });
    if (!account) throw new NotFoundException('Bank account not found');

    return this.prisma.bankAccount.update({
      where: { id },
      data: { ...dto },
    });
  }

  async remove(id: string, namespaceId: string) {
    const account = await this.prisma.bankAccount.findFirst({ where: { id, namespaceId } });
    if (!account) throw new NotFoundException('Bank account not found');

    const inUse = await this.prisma.offRampRoute.findFirst({ where: { bankAccountId: id } });
    if (inUse) throw new ConflictException('Bank account is linked to an active route and cannot be deleted');

    await this.prisma.bankAccount.delete({ where: { id } });
  }

  private maskIban(iban: string): string {
    if (iban.length <= 8) return iban;
    return iban.slice(0, 4) + '****' + iban.slice(-4);
  }
}
