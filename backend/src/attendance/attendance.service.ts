import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '@/supabase/supabase.service';
import { CacheService } from '@/cache/cache.service';
import { MarkAttendanceDto } from './dto/mark-attendance.dto';
import { BulkMarkAttendanceDto } from './dto/bulk-mark-attendance.dto';
import { UpdateAttendanceDto } from './dto/update-attendance.dto';
import type {
  AttendanceRecordItem,
  ClassRosterAttendance,
  RosterEntry,
  StudentAttendanceRange,
  StudentAttendanceSummary,
} from './transformer';

const ATTENDANCE_TTL = 60 * 5;

interface AttendanceRow {
  id: string;
  student_id: string;
  student_group_id: string;
  attendance_date: string;
  status: 'present' | 'absent' | 'late';
  notes: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string | null;
  updated_at: string | null;
}

@Injectable()
export class AttendanceService {
  private readonly logger = new Logger(AttendanceService.name);

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly cache: CacheService,
  ) {}

  async getClassRosterForDate(
    classId: string,
    date: string,
  ): Promise<ClassRosterAttendance> {
    const cacheKey = `attendance:roster:${classId}:${date}`;
    const cached = (await this.cache.get(
      cacheKey,
    )) as ClassRosterAttendance | null;
    if (cached) return cached;

    const supabase = this.supabaseService.getServiceClient();

    const { data: enrollments, error: enrollErr } = await supabase
      .schema('student')
      .from('student_group_enrollment')
      .select(
        `
        student:student_id (
          id,
          first_name,
          last_name
        )
        `,
      )
      .eq('student_group_id', classId);

    if (enrollErr) {
      this.logger.error(
        `Failed to load enrollments for class ${classId}: ${enrollErr.message}`,
      );
      throw new BadRequestException('Failed to load class roster');
    }

    const { data: records, error: recErr } = await supabase
      .schema('student')
      .from('attendance_record')
      .select('*')
      .eq('student_group_id', classId)
      .eq('attendance_date', date);

    if (recErr) {
      this.logger.error(
        `Failed to load attendance for class ${classId} on ${date}: ${recErr.message}`,
      );
      throw new BadRequestException('Failed to load attendance');
    }

    const recordByStudent = new Map<string, AttendanceRow>();
    for (const r of (records ?? []) as AttendanceRow[]) {
      recordByStudent.set(r.student_id, r);
    }

    const entries: RosterEntry[] = (enrollments ?? [])
      .map((e: any) => e.student)
      .filter((s: any) => s != null)
      .map((s: any) => {
        const r = recordByStudent.get(s.id as string);
        return {
          studentId: s.id,
          firstName: s.first_name,
          lastName: s.last_name,
          record: r ? this.toItem(r) : null,
        };
      });

    const result: ClassRosterAttendance = {
      date,
      classId,
      entries,
    };

    await this.cache.set(cacheKey, result, ATTENDANCE_TTL);
    return result;
  }

  async mark(
    classId: string,
    userId: string,
    dto: MarkAttendanceDto,
  ): Promise<AttendanceRecordItem> {
    if (dto.studentId == null) {
      throw new BadRequestException('studentId is required');
    }

    await this.assertEnrolled(classId, [dto.studentId]);

    const supabase = this.supabaseService.getServiceClient();
    const row = await this.upsertOne(supabase, {
      student_id: dto.studentId,
      student_group_id: classId,
      attendance_date: dto.date,
      status: dto.status,
      notes: dto.notes ?? null,
      user_id: userId,
    });

    await this.invalidateClassDate(classId, dto.date);
    return this.toItem(row);
  }

  async bulkMark(classId: string, userId: string, dto: BulkMarkAttendanceDto) {
    const studentIds = dto.entries.map((e) => e.studentId);
    if (new Set(studentIds).size !== studentIds.length) {
      throw new BadRequestException(
        'Each student may appear at most once per bulk request',
      );
    }
    await this.assertEnrolled(classId, studentIds);

    const supabase = this.supabaseService.getServiceClient();
    const nowIso = new Date().toISOString();

    const rows = dto.entries.map((e) => ({
      student_id: e.studentId,
      student_group_id: classId,
      attendance_date: dto.date,
      status: e.status,
      notes: e.notes ?? null,
      created_by: userId,
      updated_by: userId,
      updated_at: nowIso,
    }));

    const { data, error } = await supabase
      .schema('student')
      .from('attendance_record')
      .upsert(rows, {
        onConflict: 'student_id,student_group_id,attendance_date',
      })
      .select();

    if (error) {
      this.logger.error(`Failed to bulk mark attendance: ${error.message}`);
      throw new BadRequestException('Failed to mark attendance');
    }

    await this.invalidateClassDate(classId, dto.date);
    return {
      marked: data?.length ?? 0,
      message: 'Attendance recorded',
    };
  }

  async update(
    classId: string,
    recordId: string,
    userId: string,
    dto: UpdateAttendanceDto,
  ): Promise<AttendanceRecordItem> {
    if (dto.status == null && dto.notes == null) {
      throw new BadRequestException('Nothing to update');
    }

    const supabase = this.supabaseService.getServiceClient();
    const patch: Record<string, unknown> = {
      updated_by: userId,
      updated_at: new Date().toISOString(),
    };
    if (dto.status != null) patch.status = dto.status;
    if (dto.notes !== undefined) patch.notes = dto.notes ?? null;

    const { data, error } = await supabase
      .schema('student')
      .from('attendance_record')
      .update(patch)
      .eq('id', recordId)
      .eq('student_group_id', classId)
      .select()
      .single();

    if (error || !data) {
      if (error?.code === 'PGRST116') {
        throw new NotFoundException('Attendance record not found');
      }
      this.logger.error(
        `Failed to update attendance ${recordId}: ${error?.message}`,
      );
      throw new BadRequestException('Failed to update attendance');
    }

    const row = data as AttendanceRow;
    await this.invalidateClassDate(row.student_group_id, row.attendance_date);
    return this.toItem(row);
  }

  async delete(classId: string, recordId: string) {
    const supabase = this.supabaseService.getServiceClient();

    const { data: existing, error: findErr } = await supabase
      .schema('student')
      .from('attendance_record')
      .select('student_group_id, attendance_date')
      .eq('id', recordId)
      .eq('student_group_id', classId)
      .maybeSingle();

    if (findErr) {
      this.logger.error(
        `Failed to lookup attendance ${recordId}: ${findErr.message}`,
      );
      throw new BadRequestException('Failed to delete attendance');
    }
    if (!existing) {
      throw new NotFoundException('Attendance record not found');
    }

    const { error } = await supabase
      .schema('student')
      .from('attendance_record')
      .delete()
      .eq('id', recordId)
      .eq('student_group_id', classId);

    if (error) {
      this.logger.error(
        `Failed to delete attendance ${recordId}: ${error.message}`,
      );
      throw new BadRequestException('Failed to delete attendance');
    }

    await this.invalidateClassDate(
      existing.student_group_id as string,
      existing.attendance_date as string,
    );
    return { message: 'Attendance record deleted' };
  }

  private async upsertOne(
    supabase: ReturnType<SupabaseService['getServiceClient']>,
    row: {
      student_id: string;
      student_group_id: string;
      attendance_date: string;
      status: 'present' | 'absent' | 'late';
      notes: string | null;
      user_id: string;
    },
  ): Promise<AttendanceRow> {
    const nowIso = new Date().toISOString();
    const { data, error } = await supabase
      .schema('student')
      .from('attendance_record')
      .upsert(
        {
          student_id: row.student_id,
          student_group_id: row.student_group_id,
          attendance_date: row.attendance_date,
          status: row.status,
          notes: row.notes,
          created_by: row.user_id,
          updated_by: row.user_id,
          updated_at: nowIso,
        },
        { onConflict: 'student_id,student_group_id,attendance_date' },
      )
      .select()
      .single();

    if (error || !data) {
      this.logger.error(`Failed to upsert attendance: ${error?.message}`);
      throw new BadRequestException('Failed to record attendance');
    }
    return data as AttendanceRow;
  }

  async getStudentRange(
    classId: string,
    studentId: string,
    from: string,
    to: string,
  ): Promise<StudentAttendanceRange> {
    this.assertRange(from, to);
    await this.assertStudentInClass(classId, studentId);

    const supabase = this.supabaseService.getServiceClient();
    const { data, error } = await supabase
      .schema('student')
      .from('attendance_record')
      .select('*')
      .eq('student_group_id', classId)
      .eq('student_id', studentId)
      .gte('attendance_date', from)
      .lte('attendance_date', to)
      .order('attendance_date', { ascending: true });

    if (error) {
      this.logger.error(
        `Failed to load student attendance range: ${error.message}`,
      );
      throw new BadRequestException('Failed to load attendance');
    }

    return {
      studentId,
      classId,
      from,
      to,
      records: ((data ?? []) as AttendanceRow[]).map((r) => this.toItem(r)),
    };
  }

  async getStudentSummary(
    classId: string,
    studentId: string,
    from: string,
    to: string,
  ): Promise<StudentAttendanceSummary> {
    this.assertRange(from, to);
    await this.assertStudentInClass(classId, studentId);

    const supabase = this.supabaseService.getServiceClient();
    const { data, error } = await supabase
      .schema('student')
      .from('attendance_record')
      .select('status')
      .eq('student_group_id', classId)
      .eq('student_id', studentId)
      .gte('attendance_date', from)
      .lte('attendance_date', to);

    if (error) {
      this.logger.error(
        `Failed to load student attendance summary: ${error.message}`,
      );
      throw new BadRequestException('Failed to load attendance summary');
    }

    const counts = { present: 0, absent: 0, late: 0, total: 0 };
    for (const row of data ?? []) {
      const status = row.status;
      counts[status] += 1;
      counts.total += 1;
    }

    // Late counts as attended for percentage purposes -- a student showed
    // up, just not on time. If a stricter rule is needed we can expose a
    // query flag later.
    const attended = counts.present + counts.late;
    const presentPercentage =
      counts.total === 0
        ? 0
        : Math.round((attended / counts.total) * 1000) / 10;

    return {
      studentId,
      classId,
      from,
      to,
      counts,
      presentPercentage,
    };
  }

  async getClassSummary(classId: string, from: string, to: string) {
    this.assertRange(from, to);

    const { data, error } = await this.supabaseService
      .getServiceClient()
      .functions.invoke('attendance-summary', {
        body: { classId, from, to },
      });

    if (error || !data) {
      this.logger.error(
        `Failed to load class attendance summary: ${error?.message ?? 'empty response'}`,
      );
      throw new BadRequestException('Failed to load attendance summary');
    }

    return data;
  }

  async assertCanViewClass(userId: string, classId: string) {
    const supabase = this.supabaseService.getServiceClient();

    const { data: profile } = await supabase
      .from('user_profile')
      .select('role, school_id')
      .eq('id', userId)
      .single();

    if (profile?.role === 'admin') {
      const { data: studentGroup } = await supabase
        .from('student_group')
        .select('academic_year:academic_year_id(school_id)')
        .eq('id', classId)
        .maybeSingle();
      const classSchoolId = (
        studentGroup?.academic_year as { school_id?: string } | null
      )?.school_id;
      if (classSchoolId && classSchoolId === profile.school_id) return;
      throw new ForbiddenException('Not authorized to view this class');
    }

    const { data: assignment } = await supabase
      .schema('staff')
      .from('teacher_group_assignment')
      .select('id')
      .eq('user_profile_id', userId)
      .eq('student_group_id', classId)
      .maybeSingle();

    if (assignment) return;
    throw new ForbiddenException('Not authorized to view this class');
  }

  private assertRange(from: string, to: string) {
    if (from > to) {
      throw new BadRequestException('`from` must be on or before `to`');
    }
  }

  private async assertStudentInClass(classId: string, studentId: string) {
    const supabase = this.supabaseService.getServiceClient();
    const { data, error } = await supabase
      .schema('student')
      .from('student_group_enrollment')
      .select('id')
      .eq('student_group_id', classId)
      .eq('student_id', studentId)
      .maybeSingle();

    if (error) {
      this.logger.error(`Failed to verify enrollment: ${error.message}`);
      throw new BadRequestException('Failed to verify class enrollment');
    }
    if (!data) {
      throw new NotFoundException('Student is not enrolled in this class');
    }
  }

  private async assertEnrolled(classId: string, studentIds: string[]) {
    if (studentIds.length === 0) return;
    const supabase = this.supabaseService.getServiceClient();
    const { data, error } = await supabase
      .schema('student')
      .from('student_group_enrollment')
      .select('student_id')
      .eq('student_group_id', classId)
      .in('student_id', studentIds);

    if (error) {
      this.logger.error(`Failed to verify enrollment: ${error.message}`);
      throw new BadRequestException('Failed to verify class enrollment');
    }

    const enrolled = new Set((data ?? []).map((r) => r.student_id));
    const missing = studentIds.filter((id) => !enrolled.has(id));
    if (missing.length > 0) {
      throw new BadRequestException(
        'One or more students are not enrolled in this class',
      );
    }
  }

  private async invalidateClassDate(classId: string, date: string) {
    await this.cache.delete(`attendance:roster:${classId}:${date}`);
  }

  private toItem(row: AttendanceRow): AttendanceRecordItem {
    return {
      id: row.id,
      studentId: row.student_id,
      studentGroupId: row.student_group_id,
      date: row.attendance_date,
      status: row.status,
      notes: row.notes,
      createdBy: row.created_by,
      updatedBy: row.updated_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
