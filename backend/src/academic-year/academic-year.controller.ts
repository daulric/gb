import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AcademicYearService } from './academic-year.service';
import { AuthGuard } from '@/auth/auth.guard';
import { PermissionGuard } from '@/permission/permission.guard';
import { RequirePermission } from '@/permission/require-permission.decorator';
import { VersioningService } from '@/versioning/versioning.service';
import { CreateAcademicYearDto } from './dto/create-academic-year.dto';
import { UpdateAcademicYearDto } from './dto/update-academic-year.dto';
@ApiTags('Academic Years')
@ApiBearerAuth()
@UseGuards(AuthGuard, PermissionGuard)
@Controller('academic-years')
export class AcademicYearController {
  constructor(
    private readonly academicYearService: AcademicYearService,
    private readonly versioning: VersioningService,
  ) {}

  @RequirePermission('academic-year', 'create')
  @Post()
  async create(@Req() req: any, @Body() dto: CreateAcademicYearDto) {
    const user_id: string = req.user.id;
    const raw = await this.academicYearService.create(user_id, dto);
    return this.versioning.resolve(req, 'academicYear.created')(raw);
  }

  @RequirePermission('academic-year', 'read')
  @Get()
  async findAll(@Req() req: any) {
    const user_id: string = req.user.id;
    const raw = await this.academicYearService.findAll(user_id);
    return this.versioning.resolve(req, 'academicYear.list')(raw);
  }

  @RequirePermission('academic-year', 'read')
  @Get('active')
  async findActive(@Req() req: any) {
    const user_id: string = req.user.id;
    const raw = await this.academicYearService.findActive(user_id);
    return this.versioning.resolve(req, 'academicYear.detail')(raw);
  }

  @RequirePermission('academic-year', 'read')
  @Get(':id')
  async findOne(@Req() req: any, @Param('id') id: string) {
    const user_id: string = req.user.id;
    const raw = await this.academicYearService.findOne(user_id, id);
    return this.versioning.resolve(req, 'academicYear.detail')(raw);
  }

  @RequirePermission('academic-year', 'update')
  @Patch(':id')
  async update(
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: UpdateAcademicYearDto,
  ) {
    const user_id: string = req.user.id;
    const raw = await this.academicYearService.update(user_id, id, dto);
    return this.versioning.resolve(req, 'academicYear.updated')(raw);
  }

  @RequirePermission('academic-year', 'update')
  @Patch(':id/activate')
  async setActive(@Req() req: any, @Param('id') id: string) {
    const user_id: string = req.user.id;
    const raw = await this.academicYearService.setActive(user_id, id);
    return this.versioning.resolve(req, 'academicYear.updated')(raw);
  }

  @RequirePermission('academic-year', 'update')
  @Patch(':id/deactivate')
  async deactivate(@Req() req: any, @Param('id') id: string) {
    const user_id: string = req.user.id;
    const raw = await this.academicYearService.deactivate(user_id, id);
    return this.versioning.resolve(req, 'academicYear.updated')(raw);
  }
}
