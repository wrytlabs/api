import { OutboundInvoiceStatus } from '@prisma/client';

export interface InvoiceItemDto {
  description: string;
  quantity: number;
  unitPrice: number;
}

export class InvoiceResponseDto {
  id: string;
  namespaceId: string | null;
  number: string;
  status: OutboundInvoiceStatus;
  recipientName: string;
  recipientEmail: string | null;
  recipientAddress: string | null;
  currency: string;
  issueDate: Date;
  dueDate: Date | null;
  notes: string | null;
  items: InvoiceItemDto[];
  subtotal: string;
  total: string;
  createdAt: Date;
  updatedAt: Date;
}
