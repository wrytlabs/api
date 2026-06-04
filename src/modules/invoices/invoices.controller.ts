import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Param,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiHeader, ApiTags, ApiOperation, ApiResponse, ApiSecurity, ApiParam, ApiBody } from '@nestjs/swagger';
import { InvoicesService } from './invoices.service';
import { ScopesGuard } from '../../common/guards/scopes.guard';
import { RequireScopes } from '../../common/decorators/require-scopes.decorator';
import { NamespaceGuard } from '../../common/guards/namespace.guard';
import { CurrentNamespace } from '../../common/decorators/current-namespace.decorator';
import type { Namespace } from '@prisma/client';

@ApiTags('Invoices')
@ApiSecurity('api-key')
@UseGuards(ScopesGuard, NamespaceGuard)
@RequireScopes('USER')
@Controller('invoices')
@ApiHeader({ name: 'X-Namespace-Id', description: 'Namespace ID', required: true })
export class InvoicesController {
  constructor(private readonly service: InvoicesService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new invoice' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['recipientName', 'items'],
      properties: {
        recipientName:    { type: 'string' },
        recipientEmail:   { type: 'string', nullable: true },
        recipientAddress: { type: 'string', nullable: true },
        currency:         { type: 'string', example: 'CHF' },
        issueDate:        { type: 'string', format: 'date' },
        dueDate:          { type: 'string', format: 'date', nullable: true },
        notes:            { type: 'string', nullable: true },
        items: {
          type: 'array',
          items: {
            type: 'object',
            required: ['description', 'quantity', 'unitPrice'],
            properties: {
              description: { type: 'string' },
              quantity:    { type: 'number' },
              unitPrice:   { type: 'number' },
            },
          },
        },
      },
    },
  })
  @ApiResponse({ status: 201, description: 'Invoice created' })
  create(@CurrentNamespace() namespace: Namespace, @Body() body: Parameters<typeof this.service.create>[1]) {
    return this.service.create(namespace.id, body);
  }

  @Get()
  @ApiOperation({ summary: 'List namespace invoices' })
  @ApiResponse({ status: 200, description: 'Array of invoices' })
  list(@CurrentNamespace() namespace: Namespace) {
    return this.service.list(namespace.id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single invoice' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 404, description: 'Invoice not found' })
  get(@CurrentNamespace() namespace: Namespace, @Param('id') id: string) {
    return this.service.get(id, namespace.id);
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update a draft invoice' })
  @ApiParam({ name: 'id' })
  update(
    @CurrentNamespace() namespace: Namespace,
    @Param('id') id: string,
    @Body() body: Parameters<typeof this.service.update>[2],
  ) {
    return this.service.update(id, namespace.id, body);
  }

  @Patch(':id/send')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark invoice as sent' })
  @ApiParam({ name: 'id' })
  send(@CurrentNamespace() namespace: Namespace, @Param('id') id: string) {
    return this.service.send(id, namespace.id);
  }

  @Patch(':id/mark-paid')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark invoice as paid' })
  @ApiParam({ name: 'id' })
  markPaid(@CurrentNamespace() namespace: Namespace, @Param('id') id: string) {
    return this.service.markPaid(id, namespace.id);
  }

  @Patch(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel an invoice' })
  @ApiParam({ name: 'id' })
  cancel(@CurrentNamespace() namespace: Namespace, @Param('id') id: string) {
    return this.service.cancel(id, namespace.id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete an invoice' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 404, description: 'Invoice not found' })
  delete(@CurrentNamespace() namespace: Namespace, @Param('id') id: string) {
    return this.service.delete(id, namespace.id);
  }
}
