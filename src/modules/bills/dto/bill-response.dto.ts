import { InvoiceStatus } from '@prisma/client';

export class BillResponseDto {
  id: string;
  namespaceId: string | null;
  fileName: string;
  fileType: string;
  status: InvoiceStatus;
  fromName: string | null;
  toName: string | null;
  amount: string | null;
  currency: string | null;
  reference: string | null;
  itemTags: string[];
  safeAddress: string | null;
  paidTxHash: string | null;
  paidAt: Date | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}
