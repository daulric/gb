import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AuthGuard } from '@/auth/auth.guard';
import { PermissionGuard } from '@/permission/permission.guard';
import { RequirePermission } from '@/permission/require-permission.decorator';
import { VersioningService } from '@/versioning/versioning.service';
import { AssessmentService } from './assessment.service';
import { CreateAssessmentDto } from './dto/create-assessment.dto';
import { UpdateAssessmentDto } from './dto/update-assessment.dto';
import { ExcludeDto } from './dto/exclude.dto';

@ApiTags('Assessments')
@ApiBearerAuth()
@Controller('assessments')
@UseGuards(AuthGuard, PermissionGuard)
export class AssessmentController {
  constructor(
    private readonly assessmentService: AssessmentService,
    private readonly versioning: VersioningService,
  ) {}

  @RequirePermission('assessment', 'read')
  @Get()
  async findByTermAndSubject(
    @Query('termId') termId: string,
    @Query('subjectId') subjectId: string,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const raw = await this.assessmentService.findByTermAndSubject(
      termId,
      subjectId,
      req,
      reply,
    );
    return this.versioning.resolve(req, 'assessment.list')(raw);
  }

  @RequirePermission('assessment', 'read')
  @Get(':id')
  async findOne(
    @Param('id') id: string,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const raw = await this.assessmentService.findOne(id, req, reply);
    return this.versioning.resolve(req, 'assessment.detail')(raw);
  }

  @RequirePermission('assessment', 'create')
  @Post()
  async create(
    @Body() dto: CreateAssessmentDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const raw = await this.assessmentService.create(
      (req as FastifyRequest & { user: { id: string } }).user.id,
      dto,
      req,
      reply,
    );
    return this.versioning.resolve(req, 'assessment.created')(raw);
  }

  @RequirePermission('assessment', 'update')
  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateAssessmentDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const raw = await this.assessmentService.update(id, dto, req, reply);
    return this.versioning.resolve(req, 'assessment.updated')(raw);
  }

  @RequirePermission('assessment', 'update')
  @Patch(':id/exclude')
  async exclude(
    @Param('id') id: string,
    @Body() dto: ExcludeDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const raw = await this.assessmentService.exclude(id, dto, req, reply);
    return this.versioning.resolve(req, 'assessment.excluded')(raw);
  }

  @RequirePermission('assessment', 'delete')
  @Delete(':id')
  async delete(
    @Param('id') id: string,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const raw = await this.assessmentService.delete(id, req, reply);
    return this.versioning.resolve(req, 'assessment.deleted')(raw);
  }
}
