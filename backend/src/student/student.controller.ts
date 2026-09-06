import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '@/auth/auth.guard';
import { PermissionGuard } from '@/permission/permission.guard';
import { RequirePermission } from '@/permission/require-permission.decorator';
import { PaginationQueryDto } from '@/pagination/pagination.dto';
import { VersioningService } from '@/versioning/versioning.service';
import { StudentService } from './student.service';
import { CreateStudentDto } from './dto/create-student.dto';
import { UpdateStudentDto } from './dto/update-student.dto';

@ApiTags('Students')
@ApiBearerAuth()
@Controller('students')
@UseGuards(AuthGuard, PermissionGuard)
export class StudentController {
  constructor(
    private readonly studentService: StudentService,
    private readonly versioning: VersioningService,
  ) {}

  @RequirePermission('student', 'read')
  @Get()
  async findAll(
    @Req() req: any,
    @Query('search') search?: string,
    @Query() pagination?: PaginationQueryDto,
  ) {
    const hasPaginationParams =
      pagination?.page !== undefined || pagination?.cursor !== undefined;

    const userId: string = req.user.id;

    if (!hasPaginationParams) {
      const raw = await this.studentService.findAll(userId, search);
      return this.versioning.resolve(req, 'student.list')(raw);
    }

    const raw = await this.studentService.findAllPaginated(
      userId,
      pagination,
      search,
    );
    return this.versioning.resolve(req, 'student.paginated')(raw);
  }

  @RequirePermission('student', 'read')
  @Get(':id')
  async findOne(@Req() req: any, @Param('id') id: string) {
    const userId: string = req.user.id;
    const raw = await this.studentService.findOne(userId, id);
    return this.versioning.resolve(req, 'student.detail')(raw);
  }

  @RequirePermission('student', 'create')
  @Post()
  async create(@Req() req: any, @Body() dto: CreateStudentDto) {
    const userId: string = req.user.id;
    const raw = await this.studentService.create(userId, dto);
    return this.versioning.resolve(req, 'student.created')(raw);
  }

  @RequirePermission('student', 'update')
  @Patch(':id')
  async update(
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: UpdateStudentDto,
  ) {
    const userId: string = req.user.id;
    const raw = await this.studentService.update(userId, id, dto);
    return this.versioning.resolve(req, 'student.updated')(raw);
  }
}
