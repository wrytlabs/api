import {
  Controller, Get, Post, Patch, Delete, Body, Param,
  HttpCode, HttpStatus, UseGuards,
} from '@nestjs/common';
import { ApiHeader, ApiTags, ApiOperation, ApiResponse, ApiSecurity, ApiParam, ApiBody } from '@nestjs/swagger';
import { OffRampRoutesService, CreateRouteDto, UpdateRouteDto } from './offramp-routes.service';
import { ScopesGuard } from '../../common/guards/scopes.guard';
import { RequireScopes } from '../../common/decorators/require-scopes.decorator';
import { NamespaceGuard } from '../../common/guards/namespace.guard';
import { CurrentNamespace } from '../../common/decorators/current-namespace.decorator';
import type { Namespace } from '@prisma/client';

@ApiTags('Off-Ramp Routes')
@ApiSecurity('api-key')
@UseGuards(ScopesGuard, NamespaceGuard)
@RequireScopes('OFFRAMP')
@Controller('offramp/routes')
@ApiHeader({ name: 'X-Namespace-Id', description: 'Namespace ID', required: true })
export class OffRampRoutesController {
  constructor(private readonly service: OffRampRoutesService) {}

  @Get()
  @ApiOperation({ summary: 'List off-ramp routes for the namespace' })
  @ApiResponse({ status: 200 })
  list(@CurrentNamespace() namespace: Namespace) {
    return this.service.list(namespace.id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single route with deposit address' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 404, description: 'Route not found' })
  get(@CurrentNamespace() namespace: Namespace, @Param('id') id: string) {
    return this.service.get(id, namespace.id);
  }

  @Post()
  @ApiOperation({
    summary: 'Create an off-ramp route',
    description: 'Automatically provisions a dedicated Safe wallet for the namespace. The returned `depositAddress` is where crypto is sent.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['label', 'targetCurrency', 'bankAccountId'],
      properties: {
        label: { type: 'string', example: 'monthly-salary' },
        targetCurrency: { type: 'string', enum: ['CHF', 'EUR'], example: 'CHF' },
        bankAccountId: { type: 'string', example: 'cm9ba001abc' },
      },
    },
  })
  @ApiResponse({ status: 201, description: 'Route created with a provisioned Safe wallet deposit address' })
  @ApiResponse({ status: 400, description: 'Bank account currency does not match targetCurrency' })
  @ApiResponse({ status: 404, description: 'Bank account not found' })
  @ApiResponse({ status: 409, description: 'Label already in use' })
  create(@CurrentNamespace() namespace: Namespace, @Body() dto: CreateRouteDto) {
    return this.service.create(namespace.id, dto);
  }

  @Patch(':id/pause')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Pause an active route' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Route paused' })
  @ApiResponse({ status: 400, description: 'Route is already paused' })
  @ApiResponse({ status: 404, description: 'Route not found' })
  pause(@CurrentNamespace() namespace: Namespace, @Param('id') id: string) {
    return this.service.pause(id, namespace.id);
  }

  @Patch(':id/activate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Activate a paused route' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Route activated' })
  @ApiResponse({ status: 400, description: 'Route is already active' })
  @ApiResponse({ status: 404, description: 'Route not found' })
  activate(@CurrentNamespace() namespace: Namespace, @Param('id') id: string) {
    return this.service.activate(id, namespace.id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('ADMIN')
  @ApiOperation({ summary: 'Delete a route (admin only)' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Route deleted' })
  @ApiResponse({ status: 404, description: 'Route not found' })
  delete(@Param('id') id: string) {
    return this.service.delete(id);
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update route label' })
  @ApiParam({ name: 'id' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: { label: { type: 'string', example: 'quarterly-bonus' } },
    },
  })
  @ApiResponse({ status: 200, description: 'Route updated' })
  @ApiResponse({ status: 404, description: 'Route not found' })
  @ApiResponse({ status: 409, description: 'Label already in use' })
  update(@CurrentNamespace() namespace: Namespace, @Param('id') id: string, @Body() dto: UpdateRouteDto) {
    return this.service.update(id, namespace.id, dto);
  }
}
