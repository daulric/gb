import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '@/auth/auth.guard';
import { AdminGuard } from '@/auth/admin.guard';
import { PermissionGuard } from '@/permission/permission.guard';
import { RequirePermission } from '@/permission/require-permission.decorator';
import { VersioningService } from '@/versioning/versioning.service';
import { GradeScaleService } from './grade-scale.service';
import { CreateGradeScaleDto } from './dto/create-grade-scale.dto';
import { UpdateGradeScaleDto } from './dto/update-grade-scale.dto';
import { ReplaceBandsDto } from './dto/replace-bands.dto';

@ApiTags('Grade Scales')
@ApiBearerAuth()
@Controller('grade-scales')
@UseGuards(AuthGuard, PermissionGuard)
export class GradeScaleController {
  constructor(
    private readonly service: GradeScaleService,
    private readonly versioning: VersioningService,
  ) {}

  @RequirePermission('grade-scale', 'read')
  @Get()
  async list(@Req() req: any) {
    const userId: string = req.user.id;
    const raw = await this.service.list(userId);
    return this.versioning.resolve(req, 'gradeScale.list')(raw);
  }

  @RequirePermission('grade-scale', 'read')
  @Get('default')
  async getDefault(@Req() req: any) {
    const userId: string = req.user.id;
    const raw = await this.service.getDefault(userId);
    return this.versioning.resolve(req, 'gradeScale.detail')(raw);
  }

  @RequirePermission('grade-scale', 'read')
  @Get(':id')
  async get(@Req() req: any, @Param('id') id: string) {
    const userId: string = req.user.id;
    const raw = await this.service.get(id, userId);
    return this.versioning.resolve(req, 'gradeScale.detail')(raw);
  }

  @RequirePermission('grade-scale', 'create')
  @UseGuards(AdminGuard)
  @Post()
  async create(@Req() req: any, @Body() dto: CreateGradeScaleDto) {
    const userId: string = req.user.id;
    const raw = await this.service.create(userId, dto);
    return this.versioning.resolve(req, 'gradeScale.created')(raw);
  }

  @RequirePermission('grade-scale', 'update')
  @UseGuards(AdminGuard)
  @Patch(':id')
  async update(
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: UpdateGradeScaleDto,
  ) {
    const userId: string = req.user.id;
    const raw = await this.service.update(id, userId, dto);
    return this.versioning.resolve(req, 'gradeScale.updated')(raw);
  }

  @RequirePermission('grade-scale', 'update')
  @UseGuards(AdminGuard)
  @Put(':id/bands')
  async replaceBands(
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: ReplaceBandsDto,
  ) {
    const userId: string = req.user.id;
    const raw = await this.service.replaceBands(id, userId, dto);
    return this.versioning.resolve(req, 'gradeScale.bandsReplaced')(raw);
  }

  @RequirePermission('grade-scale', 'update')
  @UseGuards(AdminGuard)
  @Post(':id/set-default')
  async setDefault(@Req() req: any, @Param('id') id: string) {
    const userId: string = req.user.id;
    const raw = await this.service.setDefault(id, userId);
    return this.versioning.resolve(req, 'gradeScale.defaultSet')(raw);
  }

  @RequirePermission('grade-scale', 'delete')
  @UseGuards(AdminGuard)
  @Delete(':id')
  async remove(@Req() req: any, @Param('id') id: string) {
    const userId: string = req.user.id;
    const raw = await this.service.delete(id, userId);
    return this.versioning.resolve(req, 'gradeScale.deleted')(raw);
  }
}
