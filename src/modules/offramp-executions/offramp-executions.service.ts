import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { OffRampExecutionStatus } from '@prisma/client';
import { PrismaService } from '../../core/database/prisma.service';
import { OFFRAMP_QUEUE, OffRampJobData } from '../../core/offramp/offramp.queue';

@Injectable()
export class OffRampExecutionsService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(OFFRAMP_QUEUE) private readonly queue: Queue<OffRampJobData>,
  ) {}

  async list(userId: string, routeId?: string) {
    return this.prisma.offRampExecution.findMany({
      where: { userId, ...(routeId ? { routeId } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  async get(id: string, userId: string) {
    const execution = await this.prisma.offRampExecution.findFirst({ where: { id, userId } });
    if (!execution) throw new NotFoundException('Execution not found');
    return execution;
  }

  // Internal: create execution record
  async create(data: {
    routeId: string;
    userId: string;
    depositTokenSymbol: string;
    depositTokenAmount: string;
    depositTxHash: string;
  }) {
    return this.prisma.offRampExecution.create({ data });
  }

  // Internal: advance status
  async updateStatus(
    id: string,
    status: OffRampExecutionStatus,
    extra?: Partial<{
      transferTxHash: string;
      krakenDepositRef: string;
      krakenOrderId: string;
      krakenFiatAmount: string;
      krakenWithdrawalId: string;
      error: string;
    }>,
  ) {
    return this.prisma.offRampExecution.update({
      where: { id },
      data: { status, ...extra },
    });
  }

  // Internal: find by deposit tx hash (de-duplication)
  async findByDepositTxHash(txHash: string) {
    return this.prisma.offRampExecution.findFirst({ where: { depositTxHash: txHash } });
  }

  // Admin: list all executions awaiting manual bank transfer
  async listPendingBankTransfers() {
    return this.prisma.offRampExecution.findMany({
      where: { status: OffRampExecutionStatus.PENDING_BANK_TRANSFER },
      include: {
        route: {
          include: {
            bankAccount: true,
          },
        },
      },
      orderBy: { updatedAt: 'asc' },
    });
  }

  // Admin: reset a FAILED execution back to DETECTED and re-enqueue it
  async requeue(id: string) {
    const execution = await this.prisma.offRampExecution.findUnique({ where: { id } });
    if (!execution) throw new NotFoundException('Execution not found');
    if (execution.status !== OffRampExecutionStatus.FAILED) {
      throw new BadRequestException(`Only FAILED executions can be requeued (status: ${execution.status})`);
    }
    const updated = await this.prisma.offRampExecution.update({
      where: { id },
      data: { status: OffRampExecutionStatus.DETECTED, error: null },
    });
    await this.queue.add(OFFRAMP_QUEUE, { executionId: id });
    return updated;
  }

  // Admin: hard delete an execution
  async delete(id: string) {
    const execution = await this.prisma.offRampExecution.findUnique({ where: { id } });
    if (!execution) throw new NotFoundException('Execution not found');
    return this.prisma.offRampExecution.delete({ where: { id } });
  }

  // Admin: mark an execution as settled after manual bank transfer
  async settle(id: string, bankTransferRef?: string) {
    const execution = await this.prisma.offRampExecution.findUnique({ where: { id } });
    if (!execution) throw new NotFoundException('Execution not found');
    if (execution.status !== OffRampExecutionStatus.PENDING_BANK_TRANSFER) {
      throw new BadRequestException(`Execution is not pending bank transfer (status: ${execution.status})`);
    }
    return this.prisma.offRampExecution.update({
      where: { id },
      data: { status: OffRampExecutionStatus.SETTLED, bankTransferRef },
    });
  }
}
