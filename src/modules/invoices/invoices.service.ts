import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { OutboundInvoiceStatus } from '@prisma/client';
import { PrismaService } from '../../core/database/prisma.service';
import type { InvoiceResponseDto, InvoiceItemDto } from './dto/invoice-response.dto';

interface CreateInvoiceDto {
  recipientName: string;
  recipientEmail?: string;
  recipientAddress?: string;
  currency?: string;
  issueDate?: string;
  dueDate?: string;
  notes?: string;
  items: InvoiceItemDto[];
}

interface UpdateInvoiceDto {
  recipientName?: string;
  recipientEmail?: string | null;
  recipientAddress?: string | null;
  currency?: string;
  issueDate?: string;
  dueDate?: string | null;
  notes?: string | null;
  items?: InvoiceItemDto[];
}

@Injectable()
export class InvoicesService {
  constructor(private readonly prisma: PrismaService) {}

  private computeTotals(items: InvoiceItemDto[]): { subtotal: number; total: number } {
    const subtotal = items.reduce((sum, i) => sum + i.quantity * i.unitPrice, 0);
    return { subtotal, total: subtotal };
  }

  private async nextNumber(namespaceId: string): Promise<string> {
    const year = new Date().getFullYear();
    const count = await this.prisma.outboundInvoice.count({ where: { namespaceId } });
    return `INV-${year}-${String(count + 1).padStart(3, '0')}`;
  }

  async create(namespaceId: string, dto: CreateInvoiceDto): Promise<InvoiceResponseDto> {
    if (!dto.items || dto.items.length === 0) {
      throw new BadRequestException('Invoice must have at least one line item');
    }
    const number = await this.nextNumber(namespaceId);
    const { subtotal, total } = this.computeTotals(dto.items);

    const invoice = await this.prisma.outboundInvoice.create({
      data: {
        namespaceId,
        number,
        recipientName: dto.recipientName,
        recipientEmail: dto.recipientEmail ?? null,
        recipientAddress: dto.recipientAddress ?? null,
        currency: dto.currency ?? 'CHF',
        issueDate: dto.issueDate ? new Date(dto.issueDate) : new Date(),
        dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
        notes: dto.notes ?? null,
        items: dto.items as object[],
        subtotal,
        total,
      },
    });

    return this.toDto(invoice);
  }

  async list(namespaceId: string): Promise<InvoiceResponseDto[]> {
    const invoices = await this.prisma.outboundInvoice.findMany({
      where: { namespaceId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return invoices.map((i) => this.toDto(i));
  }

  async get(id: string, namespaceId: string): Promise<InvoiceResponseDto> {
    const invoice = await this.prisma.outboundInvoice.findFirst({ where: { id, namespaceId } });
    if (!invoice) throw new NotFoundException('Invoice not found');
    return this.toDto(invoice);
  }

  async update(id: string, namespaceId: string, dto: UpdateInvoiceDto): Promise<InvoiceResponseDto> {
    const invoice = await this.prisma.outboundInvoice.findFirst({ where: { id, namespaceId } });
    if (!invoice) throw new NotFoundException('Invoice not found');
    if (invoice.status !== OutboundInvoiceStatus.DRAFT) {
      throw new BadRequestException('Only draft invoices can be edited');
    }

    const items = dto.items ?? (invoice.items as unknown as InvoiceItemDto[]);
    const { subtotal, total } = this.computeTotals(items);

    const updated = await this.prisma.outboundInvoice.update({
      where: { id },
      data: {
        ...(dto.recipientName !== undefined && { recipientName: dto.recipientName }),
        ...(dto.recipientEmail !== undefined && { recipientEmail: dto.recipientEmail }),
        ...(dto.recipientAddress !== undefined && { recipientAddress: dto.recipientAddress }),
        ...(dto.currency !== undefined && { currency: dto.currency }),
        ...(dto.issueDate !== undefined && { issueDate: new Date(dto.issueDate) }),
        ...(dto.dueDate !== undefined && { dueDate: dto.dueDate ? new Date(dto.dueDate) : null }),
        ...(dto.notes !== undefined && { notes: dto.notes }),
        ...(dto.items !== undefined && { items: dto.items as object[], subtotal, total }),
      },
    });

    return this.toDto(updated);
  }

  async send(id: string, namespaceId: string): Promise<InvoiceResponseDto> {
    const invoice = await this.prisma.outboundInvoice.findFirst({ where: { id, namespaceId } });
    if (!invoice) throw new NotFoundException('Invoice not found');
    if (invoice.status !== OutboundInvoiceStatus.DRAFT) {
      throw new BadRequestException('Only draft invoices can be sent');
    }
    const updated = await this.prisma.outboundInvoice.update({
      where: { id },
      data: { status: OutboundInvoiceStatus.SENT },
    });
    return this.toDto(updated);
  }

  async markPaid(id: string, namespaceId: string): Promise<InvoiceResponseDto> {
    const invoice = await this.prisma.outboundInvoice.findFirst({ where: { id, namespaceId } });
    if (!invoice) throw new NotFoundException('Invoice not found');
    if (invoice.status === OutboundInvoiceStatus.PAID) {
      throw new BadRequestException('Invoice is already paid');
    }
    const updated = await this.prisma.outboundInvoice.update({
      where: { id },
      data: { status: OutboundInvoiceStatus.PAID },
    });
    return this.toDto(updated);
  }

  async cancel(id: string, namespaceId: string): Promise<InvoiceResponseDto> {
    const invoice = await this.prisma.outboundInvoice.findFirst({ where: { id, namespaceId } });
    if (!invoice) throw new NotFoundException('Invoice not found');
    if (invoice.status === OutboundInvoiceStatus.PAID) {
      throw new BadRequestException('Paid invoices cannot be cancelled');
    }
    const updated = await this.prisma.outboundInvoice.update({
      where: { id },
      data: { status: OutboundInvoiceStatus.CANCELLED },
    });
    return this.toDto(updated);
  }

  async delete(id: string, namespaceId: string): Promise<void> {
    const invoice = await this.prisma.outboundInvoice.findFirst({ where: { id, namespaceId } });
    if (!invoice) throw new NotFoundException('Invoice not found');
    await this.prisma.outboundInvoice.delete({ where: { id } });
  }

  private toDto(invoice: Record<string, unknown>): InvoiceResponseDto {
    return {
      id: invoice.id as string,
      namespaceId: invoice.namespaceId as string,
      number: invoice.number as string,
      status: invoice.status as OutboundInvoiceStatus,
      recipientName: invoice.recipientName as string,
      recipientEmail: (invoice.recipientEmail as string | null) ?? null,
      recipientAddress: (invoice.recipientAddress as string | null) ?? null,
      currency: invoice.currency as string,
      issueDate: invoice.issueDate as Date,
      dueDate: (invoice.dueDate as Date | null) ?? null,
      notes: (invoice.notes as string | null) ?? null,
      items: (invoice.items as InvoiceItemDto[]) ?? [],
      subtotal: String(invoice.subtotal),
      total: String(invoice.total),
      createdAt: invoice.createdAt as Date,
      updatedAt: invoice.updatedAt as Date,
    };
  }
}
