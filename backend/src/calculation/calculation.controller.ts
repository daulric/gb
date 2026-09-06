import {
  Controller,
  ForbiddenException,
  Get,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '@/auth/auth.guard';
import { PermissionGuard } from '@/permission/permission.guard';
import { RequirePermission } from '@/permission/require-permission.decorator';
import { SupabaseService } from '@/supabase/supabase.service';
import { VersioningService } from '@/versioning/versioning.service';
import { CalculationService } from './calculation.service';
@ApiTags('Calculations')
@ApiBearerAuth()
@UseGuards(AuthGuard, PermissionGuard)
@Controller('calculations')
export class CalculationController {
  constructor(
    private readonly calculationService: CalculationService,
    private readonly supabaseService: SupabaseService,
    private readonly versioning: VersioningService,
  ) {}

  private async verifyClassTeacher(userId: string, studentGroupId: string) {
    const supabase = this.supabaseService.getServiceClient();

    const { data: profile } = await supabase
      .from('user_profile')
      .select('role, school_id')
      .eq('id', userId)
      .single();

    if (profile?.role === 'admin') {
      // Admin bypass is scoped to the class's school.
      const { data: studentGroup } = await supabase
        .from('student_group')
        .select('academic_year:academic_year_id(school_id)')
        .eq('id', studentGroupId)
        .maybeSingle();

      const classSchoolId = (
        studentGroup?.academic_year as { school_id?: string } | null
      )?.school_id;

      if (classSchoolId && classSchoolId === profile.school_id) return;

      throw new ForbiddenException(
        'Only the class teacher can perform this action',
      );
    }

    const { data: assignment } = await supabase
      .schema('staff')
      .from('teacher_group_assignment')
      .select('id')
      .eq('user_profile_id', userId)
      .eq('student_group_id', studentGroupId)
      .eq('is_class_teacher', true)
      .single();

    if (!assignment) {
      throw new ForbiddenException(
        'Only the class teacher can perform this action',
      );
    }
  }

  @RequirePermission('calculation', 'read')
  @Get('student-term')
  async getStudentTermResult(
    @Req() req: any,
    @Query('studentId') studentId: string,
    @Query('termId') termId: string,
    @Query('studentGroupId') studentGroupId: string,
  ) {
    const userId: string = req.user.id;
    await this.verifyClassTeacher(userId, studentGroupId);
    const raw = await this.calculationService.calculateStudentTermResult(
      studentId,
      termId,
      studentGroupId,
    );
    return this.versioning.resolve(req, 'calculation.studentTerm')(raw);
  }

  @RequirePermission('calculation', 'read')
  @Get('student-year')
  async getStudentYearResult(
    @Req() req: any,
    @Query('studentId') studentId: string,
    @Query('academicYearId') academicYearId: string,
    @Query('studentGroupId') studentGroupId: string,
  ) {
    const userId: string = req.user.id;
    await this.verifyClassTeacher(userId, studentGroupId);
    const raw = await this.calculationService.calculateStudentYearResult(
      studentId,
      academicYearId,
      studentGroupId,
    );
    return this.versioning.resolve(req, 'calculation.studentYear')(raw);
  }

  @RequirePermission('calculation', 'read')
  @Get('class-term')
  async getClassTermResults(
    @Req() req: any,
    @Query('termId') termId: string,
    @Query('studentGroupId') studentGroupId: string,
  ) {
    const userId: string = req.user.id;
    await this.verifyClassTeacher(userId, studentGroupId);
    const raw = await this.calculationService.calculateClassTermResults(
      termId,
      studentGroupId,
    );
    return this.versioning.resolve(req, 'calculation.classTerm')(raw);
  }

  @RequirePermission('calculation', 'read')
  @Get('class-year')
  async getClassYearResults(
    @Req() req: any,
    @Query('academicYearId') academicYearId: string,
    @Query('studentGroupId') studentGroupId: string,
  ) {
    const userId: string = req.user.id;
    await this.verifyClassTeacher(userId, studentGroupId);
    const raw = await this.calculationService.calculateClassYearResults(
      academicYearId,
      studentGroupId,
    );
    return this.versioning.resolve(req, 'calculation.classYear')(raw);
  }

  @RequirePermission('calculation', 'read')
  @Get('class-summary')
  async getClassSummary(
    @Req() req: any,
    @Query('termId') termId: string,
    @Query('studentGroupId') studentGroupId: string,
  ) {
    const userId: string = req.user.id;
    await this.verifyClassTeacher(userId, studentGroupId);

    const results = await this.calculationService.calculateClassTermResults(
      termId,
      studentGroupId,
    );

    const raw = results.map((r) => ({
      student: {
        id: r.studentId,
        firstName: r.firstName,
        lastName: r.lastName,
      },
      subjects: r.subjects.map((s) => ({
        subjectId: s.subjectId,
        subjectName: s.subjectName,
        average: s.termComposite,
      })),
      overallAverage: r.overallAverage,
      position: r.position,
    }));

    return this.versioning.resolve(req, 'calculation.classSummary')(raw);
  }
}
