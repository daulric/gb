import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '@/auth/auth.guard';
import { PermissionGuard } from '@/permission/permission.guard';
import { RequirePermission } from '@/permission/require-permission.decorator';
import { ClassTeacherGuard } from '@/class/class-teacher.guard';
import { VersioningService } from '@/versioning/versioning.service';
import { EnrollmentService } from './enrollment.service';
import { EnrollStudentDto } from './dto/enroll-student.dto';
import { BulkEnrollDto } from './dto/bulk-enroll.dto';
import { AssignSubjectsDto } from './dto/assign-subjects.dto';
import { BulkAssignSubjectsDto } from './dto/bulk-assign-subjects.dto';

@ApiTags('Enrollment')
@ApiBearerAuth()
@Controller('classes/:classId')
@UseGuards(AuthGuard, PermissionGuard)
export class EnrollmentController {
  constructor(
    private readonly enrollmentService: EnrollmentService,
    private readonly versioning: VersioningService,
  ) {}

  @RequirePermission('enrollment', 'read')
  @Get('students')
  async getEnrolledStudents(
    @Req() req: any,
    @Param('classId') classId: string,
    @Query('subjectId') subjectId?: string,
  ) {
    const raw = await this.enrollmentService.getEnrolledStudents(
      classId,
      req.user.id as string,
      subjectId,
    );
    return this.versioning.resolve(req, 'enrollment.students')(raw);
  }

  @RequirePermission('enrollment', 'read')
  @Get('students/:studentId/subjects')
  async getStudentSubjects(
    @Req() req: any,
    @Param('classId') classId: string,
    @Param('studentId') studentId: string,
  ) {
    const raw = await this.enrollmentService.getStudentSubjects(
      classId,
      studentId,
    );
    return this.versioning.resolve(req, 'enrollment.studentSubjects')(raw);
  }

  @RequirePermission('enrollment', 'create')
  @UseGuards(ClassTeacherGuard)
  @Post('enroll')
  async enroll(
    @Req() req: any,
    @Param('classId') classId: string,
    @Body() dto: EnrollStudentDto,
  ) {
    const raw = await this.enrollmentService.enroll(classId, dto);
    return this.versioning.resolve(req, 'enrollment.enrolled')(raw);
  }

  @RequirePermission('enrollment', 'create')
  @UseGuards(ClassTeacherGuard)
  @Post('enroll/bulk')
  async bulkEnroll(
    @Req() req: any,
    @Param('classId') classId: string,
    @Body() dto: BulkEnrollDto,
  ) {
    const raw = await this.enrollmentService.bulkEnroll(classId, dto);
    return this.versioning.resolve(req, 'enrollment.bulkEnrolled')(raw);
  }

  @RequirePermission('enrollment', 'delete')
  @UseGuards(ClassTeacherGuard)
  @Delete('enroll/:studentId')
  async unenroll(
    @Req() req: any,
    @Param('classId') classId: string,
    @Param('studentId') studentId: string,
  ) {
    const raw = await this.enrollmentService.unenroll(classId, studentId);
    return this.versioning.resolve(req, 'enrollment.unenrolled')(raw);
  }

  @RequirePermission('enrollment', 'create')
  @UseGuards(ClassTeacherGuard)
  @Post('subjects')
  async assignSubjects(
    @Req() req: any,
    @Param('classId') classId: string,
    @Body() dto: AssignSubjectsDto,
  ) {
    const raw = await this.enrollmentService.assignSubjects(classId, dto);
    return this.versioning.resolve(req, 'enrollment.subjectsAssigned')(raw);
  }

  @RequirePermission('enrollment', 'create')
  @UseGuards(ClassTeacherGuard)
  @Post('subjects/bulk')
  async bulkAssignSubjects(
    @Req() req: any,
    @Param('classId') classId: string,
    @Body() dto: BulkAssignSubjectsDto,
  ) {
    const raw = await this.enrollmentService.bulkAssignSubjects(classId, dto);
    return this.versioning.resolve(req, 'enrollment.bulkSubjectsAssigned')(raw);
  }

  @RequirePermission('enrollment', 'delete')
  @UseGuards(ClassTeacherGuard)
  @Delete('students/:studentId/subjects/:subjectId')
  async removeSubject(
    @Req() req: any,
    @Param('classId') classId: string,
    @Param('studentId') studentId: string,
    @Param('subjectId') subjectId: string,
  ) {
    const raw = await this.enrollmentService.removeSubject(
      classId,
      studentId,
      subjectId,
    );
    return this.versioning.resolve(req, 'enrollment.subjectRemoved')(raw);
  }
}
