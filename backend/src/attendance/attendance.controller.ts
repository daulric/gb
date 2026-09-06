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
import { AuthGuard } from '@/auth/auth.guard';
import { PermissionGuard } from '@/permission/permission.guard';
import { RequirePermission } from '@/permission/require-permission.decorator';
import { ClassTeacherGuard } from '@/class/class-teacher.guard';
import { VersioningService } from '@/versioning/versioning.service';
import { AttendanceService } from './attendance.service';
import { MarkAttendanceDto } from './dto/mark-attendance.dto';
import { BulkMarkAttendanceDto } from './dto/bulk-mark-attendance.dto';
import { UpdateAttendanceDto } from './dto/update-attendance.dto';
import { AttendanceRangeQueryDto } from './dto/attendance-range.dto';

@ApiTags('Attendance')
@ApiBearerAuth()
@Controller('classes/:classId/attendance')
@UseGuards(AuthGuard, PermissionGuard)
export class AttendanceController {
  constructor(
    private readonly attendanceService: AttendanceService,
    private readonly versioning: VersioningService,
  ) {}

  @RequirePermission('attendance', 'read')
  @Get()
  async roster(
    @Req() req: any,
    @Param('classId') classId: string,
    @Query('date') date: string,
  ) {
    const userId: string = req.user.id;
    await this.attendanceService.assertCanViewClass(userId, classId);
    const raw = await this.attendanceService.getClassRosterForDate(
      classId,
      date,
    );
    return this.versioning.resolve(req, 'attendance.roster')(raw);
  }

  @RequirePermission('attendance', 'create')
  @UseGuards(ClassTeacherGuard)
  @Post()
  async mark(
    @Req() req: any,
    @Param('classId') classId: string,
    @Body() dto: MarkAttendanceDto,
  ) {
    const userId: string = req.user.id;
    const raw = await this.attendanceService.mark(classId, userId, dto);
    return this.versioning.resolve(req, 'attendance.marked')(raw);
  }

  @RequirePermission('attendance', 'create')
  @UseGuards(ClassTeacherGuard)
  @Post('bulk')
  async bulkMark(
    @Req() req: any,
    @Param('classId') classId: string,
    @Body() dto: BulkMarkAttendanceDto,
  ) {
    const userId: string = req.user.id;
    const raw = await this.attendanceService.bulkMark(classId, userId, dto);
    return this.versioning.resolve(req, 'attendance.bulkMarked')(raw);
  }

  @RequirePermission('attendance', 'update')
  @UseGuards(ClassTeacherGuard)
  @Patch(':recordId')
  async update(
    @Req() req: any,
    @Param('classId') classId: string,
    @Param('recordId') recordId: string,
    @Body() dto: UpdateAttendanceDto,
  ) {
    const userId: string = req.user.id;
    const raw = await this.attendanceService.update(
      classId,
      recordId,
      userId,
      dto,
    );
    return this.versioning.resolve(req, 'attendance.updated')(raw);
  }

  @RequirePermission('attendance', 'delete')
  @UseGuards(ClassTeacherGuard)
  @Delete(':recordId')
  async remove(
    @Req() req: any,
    @Param('classId') classId: string,
    @Param('recordId') recordId: string,
  ) {
    const raw = await this.attendanceService.delete(classId, recordId);
    return this.versioning.resolve(req, 'attendance.deleted')(raw);
  }

  @RequirePermission('attendance', 'read')
  @Get('summary')
  async summary(
    @Req() req: any,
    @Param('classId') classId: string,
    @Query() range: AttendanceRangeQueryDto,
  ) {
    const userId: string = req.user.id;
    await this.attendanceService.assertCanViewClass(userId, classId);
    const raw = await this.attendanceService.getClassSummary(
      classId,
      range.from,
      range.to,
    );
    return this.versioning.resolve(req, 'attendance.classSummary')(raw);
  }

  @RequirePermission('attendance', 'read')
  @Get('students/:studentId')
  async studentRange(
    @Req() req: any,
    @Param('classId') classId: string,
    @Param('studentId') studentId: string,
    @Query() range: AttendanceRangeQueryDto,
  ) {
    const userId: string = req.user.id;
    await this.attendanceService.assertCanViewClass(userId, classId);
    const raw = await this.attendanceService.getStudentRange(
      classId,
      studentId,
      range.from,
      range.to,
    );
    return this.versioning.resolve(req, 'attendance.studentRange')(raw);
  }

  @RequirePermission('attendance', 'read')
  @Get('students/:studentId/summary')
  async studentSummary(
    @Req() req: any,
    @Param('classId') classId: string,
    @Param('studentId') studentId: string,
    @Query() range: AttendanceRangeQueryDto,
  ) {
    const userId: string = req.user.id;
    await this.attendanceService.assertCanViewClass(userId, classId);
    const raw = await this.attendanceService.getStudentSummary(
      classId,
      studentId,
      range.from,
      range.to,
    );
    return this.versioning.resolve(req, 'attendance.studentSummary')(raw);
  }
}
