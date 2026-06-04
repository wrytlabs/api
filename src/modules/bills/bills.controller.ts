import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Param,
  Body,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiHeader, ApiTags, ApiOperation, ApiResponse, ApiSecurity, ApiParam, ApiBody, ApiConsumes } from '@nestjs/swagger';
import { BillsService } from './bills.service';
import { ScopesGuard } from '../../common/guards/scopes.guard';
import { RequireScopes } from '../../common/decorators/require-scopes.decorator';
import { NamespaceGuard } from '../../common/guards/namespace.guard';
import { CurrentNamespace } from '../../common/decorators/current-namespace.decorator';
import type { Namespace } from '@prisma/client';

@ApiTags('Bills')
@ApiSecurity('api-key')
@UseGuards(ScopesGuard, NamespaceGuard)
@RequireScopes('USER')
@Controller('bills')
@ApiHeader({ name: 'X-Namespace-Id', description: 'Namespace ID', required: true })
export class BillsController {
  constructor(private readonly service: BillsService) {}

  @Post()
  @ApiOperation({ summary: 'Upload a bill file for AI extraction' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary', description: 'Bill file (PDF, JPEG, PNG, WEBP — max 10 MB)' },
      },
      required: ['file'],
    },
  })
  @ApiResponse({ status: 201, description: 'Bill created, extraction queued' })
  @UseInterceptors(FileInterceptor('file'))
  upload(
    @CurrentNamespace() namespace: Namespace,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.service.upload(namespace.id, file);
  }

  @Get()
  @ApiOperation({ summary: 'List namespace bills (latest 50)' })
  @ApiResponse({ status: 200, description: 'Array of bills (no file data)' })
  list(@CurrentNamespace() namespace: Namespace) {
    return this.service.list(namespace.id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single bill' })
  @ApiParam({ name: 'id', example: 'cm9bill001xyz' })
  @ApiResponse({ status: 404, description: 'Bill not found' })
  get(@CurrentNamespace() namespace: Namespace, @Param('id') id: string) {
    return this.service.get(id, namespace.id);
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update editable bill fields' })
  @ApiParam({ name: 'id', example: 'cm9bill001xyz' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        fromName: { type: 'string', nullable: true },
        amount:   { type: 'string', nullable: true },
        currency: { type: 'string', nullable: true },
        itemTags: { type: 'array', items: { type: 'string' } },
      },
    },
  })
  updateFields(
    @CurrentNamespace() namespace: Namespace,
    @Param('id') id: string,
    @Body() body: { fromName?: string | null; amount?: string | null; currency?: string | null; itemTags?: string[] },
  ) {
    return this.service.update(id, namespace.id, body);
  }

  @Patch(':id/mark-paid')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('ADMIN')
  @ApiOperation({ summary: 'Mark bill as paid (admin)' })
  @ApiParam({ name: 'id', example: 'cm9bill001xyz' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['paidTxHash'],
      properties: {
        paidTxHash: { type: 'string', example: '0xabc123...' },
      },
    },
  })
  @ApiResponse({ status: 400, description: 'Bill already paid' })
  @ApiResponse({ status: 404, description: 'Bill not found' })
  markPaid(@Param('id') id: string, @Body('paidTxHash') paidTxHash: string) {
    return this.service.markPaid(id, paidTxHash);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('ADMIN')
  @ApiOperation({ summary: 'Delete a bill (admin)' })
  @ApiParam({ name: 'id', example: 'cm9bill001xyz' })
  @ApiResponse({ status: 404, description: 'Bill not found' })
  delete(@Param('id') id: string) {
    return this.service.delete(id);
  }
}
