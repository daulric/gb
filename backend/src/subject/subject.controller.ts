import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '@/auth/auth.guard';
import { PermissionGuard } from '@/permission/permission.guard';
import { RequirePermission } from '@/permission/require-permission.decorator';
import { VersioningService } from '@/versioning/versioning.service';
import { SubjectService } from './subject.service';
import { CreateSubjectDto } from './dto/create-subject.dto';
import { UpdateSubjectDto } from './dto/update-subject.dto';
import { ReorderSubjectsDto } from './dto/reorder-subjects.dto';

@ApiTags('Subjects')
@ApiBearerAuth()
@Controller('subjects')
@UseGuards(AuthGuard, PermissionGuard)
export class SubjectController {
  constructor(
    private readonly subjectService: SubjectService,
    private readonly versioning: VersioningService,
  ) {}

  @RequirePermission('subject', 'read')
  @Get()
  async findAll(@Req() req: any) {
    const userId: string = req.user.id;
    const raw = await this.subjectService.findAll(userId);
    return this.versioning.resolve(req, 'subject.list')(raw);
  }

  @RequirePermission('subject', 'update')
  @Patch('reorder')
  async reorder(@Req() req: any, @Body() dto: ReorderSubjectsDto) {
    const userId: string = req.user.id;
    const raw = await this.subjectService.reorder(userId, dto);
    return this.versioning.resolve(req, 'subject.reordered')(raw);
  }

  @RequirePermission('subject', 'read')
  @Get(':id')
  async findOne(@Req() req: any, @Param('id') id: string) {
    const userId: string = req.user.id;
    const raw = await this.subjectService.findOne(userId, id);
    return this.versioning.resolve(req, 'subject.detail')(raw);
  }

  @RequirePermission('subject', 'create')
  @Post()
  async create(@Req() req: any, @Body() dto: CreateSubjectDto) {
    const userId: string = req.user.id;
    const raw = await this.subjectService.create(userId, dto);
    return this.versioning.resolve(req, 'subject.created')(raw);
  }

  @RequirePermission('subject', 'update')
  @Patch(':id')
  async update(
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: UpdateSubjectDto,
  ) {
    const userId: string = req.user.id;
    const raw = await this.subjectService.update(userId, id, dto);
    return this.versioning.resolve(req, 'subject.updated')(raw);
  }

  @RequirePermission('subject', 'delete')
  @Delete(':id')
  async delete(@Req() req: any, @Param('id') id: string) {
    const userId: string = req.user.id;
    const raw = await this.subjectService.delete(userId, id);
    return this.versioning.resolve(req, 'subject.deleted')(raw);
  }
}
