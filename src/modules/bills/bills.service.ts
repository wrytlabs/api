import { Injectable, NotFoundException, BadRequestException, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { InvoiceStatus } from '@prisma/client';
import { PrismaService } from '../../core/database/prisma.service';
import { SafeService } from '../../integrations/safe/safe.service';
import { BILLS_QUEUE, BillJobData } from './bills.queue';
import type { BillResponseDto } from './dto/bill-response.dto';

const BILL_CHAIN_ID = 1;
const STUCK_PROCESSING_THRESHOLD_MS = 10 * 60 * 1000;
const RESCUE_INTERVAL_MS = 60 * 1000;
const BILL_SAFE_LABEL = 'bills';
const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
];
const MAX_FILE_SIZE = 10 * 1024 * 1024;

@Injectable()
export class BillsService implements OnModuleInit {
  private readonly logger = new Logger(BillsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly safe: SafeService,
    @InjectQueue(BILLS_QUEUE) private readonly queue: Queue<BillJobData>,
  ) {}

  onModuleInit() {
    void this.rescueStuckBills();
    setInterval(() => void this.rescueStuckBills(), RESCUE_INTERVAL_MS);
  }

  private async rescueStuckBills(): Promise<void> {
    const threshold = new Date(Date.now() - STUCK_PROCESSING_THRESHOLD_MS);
    const stuck = await this.prisma.invoice.findMany({
      where: { status: InvoiceStatus.PROCESSING, processingStartedAt: { lt: threshold } },
      select: { id: true },
    });
    if (stuck.length === 0) return;

    this.logger.warn(`Rescuing ${stuck.length} stuck bill(s)`);
    for (const { id } of stuck) {
      await this.prisma.invoice.update({
        where: { id },
        data: { status: InvoiceStatus.PENDING, processingStartedAt: null },
      });
      await this.queue.add(BILLS_QUEUE, { billId: id });
    }
  }

  async upload(namespaceId: string, file: Express.Multer.File): Promise<BillResponseDto> {
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      throw new BadRequestException(`Unsupported file type: ${file.mimetype}. Allowed: PDF, JPEG, PNG, WEBP, GIF`);
    }
    if (file.size > MAX_FILE_SIZE) {
      throw new BadRequestException('File exceeds 10 MB limit');
    }

    const safeWallet = await this.safe.getOrCreate(namespaceId, BILL_CHAIN_ID, BILL_SAFE_LABEL);

    const bill = await this.prisma.invoice.create({
      data: {
        namespaceId,
        fileName: file.originalname,
        fileType: file.mimetype,
        fileData: Buffer.from(file.buffer),
        safeAddress: safeWallet.address,
      },
    });

    await this.queue.add(BILLS_QUEUE, { billId: bill.id });

    return this.toDto(bill);
  }

  async list(namespaceId: string): Promise<BillResponseDto[]> {
    const bills = await this.prisma.invoice.findMany({
      where: { namespaceId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      omit: { fileData: true },
    });
    return bills.map((b) => this.toDto(b));
  }

  async get(id: string, namespaceId: string): Promise<BillResponseDto> {
    const bill = await this.prisma.invoice.findFirst({
      where: { id, namespaceId },
      omit: { fileData: true },
    });
    if (!bill) throw new NotFoundException('Bill not found');
    return this.toDto(bill);
  }

  async update(
    id: string,
    namespaceId: string,
    data: { fromName?: string | null; amount?: string | null; currency?: string | null; itemTags?: string[] },
  ): Promise<BillResponseDto> {
    const bill = await this.prisma.invoice.findFirst({ where: { id, namespaceId } });
    if (!bill) throw new NotFoundException('Bill not found');
    const updated = await this.prisma.invoice.update({
      where: { id },
      data,
      omit: { fileData: true },
    });
    return this.toDto(updated);
  }

  async markPaid(id: string, paidTxHash: string): Promise<BillResponseDto> {
    const bill = await this.prisma.invoice.findUnique({ where: { id }, omit: { fileData: true } });
    if (!bill) throw new NotFoundException('Bill not found');
    if (bill.status === InvoiceStatus.PAID) {
      throw new BadRequestException('Bill is already marked as paid');
    }
    const updated = await this.prisma.invoice.update({
      where: { id },
      data: { status: InvoiceStatus.PAID, paidTxHash, paidAt: new Date() },
      omit: { fileData: true },
    });
    return this.toDto(updated);
  }

  async delete(id: string): Promise<void> {
    const bill = await this.prisma.invoice.findUnique({ where: { id } });
    if (!bill) throw new NotFoundException('Bill not found');
    await this.prisma.invoice.delete({ where: { id } });
  }

  private toDto(bill: Record<string, unknown>): BillResponseDto {
    return {
      id: bill.id as string,
      namespaceId: bill.namespaceId as string,
      fileName: bill.fileName as string,
      fileType: bill.fileType as string,
      status: bill.status as InvoiceStatus,
      fromName: (bill.fromName as string | null) ?? null,
      toName: (bill.toName as string | null) ?? null,
      amount: bill.amount != null ? String(bill.amount) : null,
      currency: (bill.currency as string | null) ?? null,
      reference: (bill.reference as string | null) ?? null,
      itemTags: (bill.itemTags as string[]) ?? [],
      safeAddress: (bill.safeAddress as string | null) ?? null,
      paidTxHash: (bill.paidTxHash as string | null) ?? null,
      paidAt: (bill.paidAt as Date | null) ?? null,
      error: (bill.error as string | null) ?? null,
      createdAt: bill.createdAt as Date,
      updatedAt: bill.updatedAt as Date,
    };
  }
}
