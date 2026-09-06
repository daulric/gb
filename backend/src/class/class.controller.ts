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
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ClassService } from './class.service';
import { AuthGuard } from '@/auth/auth.guard';
import { PermissionGuard } from '@/permission/permission.guard';
import { RequirePermission } from '@/permission/require-permission.decorator';
import { ClassTeacherGuard } from './class-teacher.guard';
import { VersioningService } from '@/versioning/versioning.service';
import { CreateClassDto } from './dto/create-class.dto';
import { UpdateClassDto } from './dto/update-class.dto';
import { AddTeacherDto } from './dto/add-teacher.dto';
@ApiTags('Classes')
@ApiBearerAuth()
@UseGuards(AuthGuard, PermissionGuard)
@Controller('classes')
export class ClassController {
  constructor(
    private readonly classService: ClassService,
    private readonly versioning: VersioningService,
  ) {}

  @RequirePermission('class', 'read')
  @Get()
  async getMyClasses(
    @Req() req: any,
    @Query('academicYearId') academicYearId?: string,
  ) {
    const raw = await this.classService.getMyClasses(
      req.user.id as string,
      academicYearId,
    );
    return this.versioning.resolve(req, 'class.list')(raw);
  }

  @RequirePermission('class', 'create')
  @Post()
  async createClass(@Req() req: any, @Body() dto: CreateClassDto) {
    const raw = await this.classService.createClass(req.user.id as string, dto);
    return this.versioning.resolve(req, 'class.created')(raw);
  }

  @RequirePermission('class', 'read')
  @Get(':classId')
  async getClassById(@Req() req: any, @Param('classId') classId: string) {
    const raw = await this.classService.getClassById(classId);
    return this.versioning.resolve(req, 'class.detail')(raw);
  }

  @RequirePermission('class', 'update')
  @UseGuards(ClassTeacherGuard)
  @Patch(':classId')
  async updateClass(
    @Req() req: any,
    @Param('classId') classId: string,
    @Body() dto: UpdateClassDto,
  ) {
    const raw = await this.classService.updateClass(classId, dto);
    return this.versioning.resolve(req, 'class.updated')(raw);
  }

  @RequirePermission('class', 'delete')
  @UseGuards(ClassTeacherGuard)
  @Delete(':classId')
  async deleteClass(@Req() req: any, @Param('classId') classId: string) {
    const raw = await this.classService.deleteClass(classId);
    return this.versioning.resolve(req, 'class.deleted')(raw);
  }

  @RequirePermission('class', 'read')
  @Get('school-teachers')
  async getSchoolTeachers(@Req() req: any) {
    const userId: string = req.user.id;
    const raw = await this.classService.getSchoolTeachers(userId);
    return this.versioning.resolve(req, 'class.teachers')(raw);
  }

  @RequirePermission('class', 'read')
  @Get(':classId/my-subjects')
  async getMySubjects(@Req() req: any, @Param('classId') classId: string) {
    const userId: string = req.user.id;
    const raw = await this.classService.getMySubjectsForClass(userId, classId);
    return this.versioning.resolve(req, 'class.subjects')(raw);
  }

  @RequirePermission('class', 'read')
  @Get(':classId/teachers')
  async getTeachers(@Req() req: any, @Param('classId') classId: string) {
    const raw = await this.classService.getTeachers(classId);
    return this.versioning.resolve(req, 'class.teachers')(raw);
  }

  @RequirePermission('class', 'update')
  @UseGuards(ClassTeacherGuard)
  @Post(':classId/teachers')
  async addTeacher(
    @Req() req: any,
    @Param('classId') classId: string,
    @Body() dto: AddTeacherDto,
  ) {
    const userId: string = req.user.id;
    const raw = await this.classService.addTeacher(userId, classId, dto);
    return this.versioning.resolve(req, 'class.teacherAdded')(raw);
  }

  @RequirePermission('class', 'update')
  @UseGuards(ClassTeacherGuard)
  @Delete(':classId/teachers/:teacherId')
  async removeTeacher(
    @Req() req: any,
    @Param('classId') classId: string,
    @Param('teacherId') teacherId: string,
  ) {
    const raw = await this.classService.removeTeacher(classId, teacherId);
    return this.versioning.resolve(req, 'class.teacherRemoved')(raw);
  }
}
