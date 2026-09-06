import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '@/supabase/supabase.service';
import { CacheService } from '@/cache/cache.service';
import {
  SubjectGradeSummary,
  StudentTermResult,
  StudentYearResult,
  YearEndSubject,
  GradingModel,
} from './interfaces/calculation.interfaces';
import type {
  GradingSystemStrategy,
  SubjectTermContext,
  SubjectYearContext,
  AssessmentRecord,
  GradeRecord,
  TermSubjectData,
} from './interfaces/grading-system.interface';
import { GradingSystemFactory } from './grading-systems/grading-system.factory';
import { simpleAverage } from './helpers/calculation.helpers';

const CALC_TTL = 60 * 60 * 24 * 30;

@Injectable()
export class CalculationService {
  private readonly logger = new Logger(CalculationService.name);

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly cache: CacheService,
    private readonly gradingSystemFactory: GradingSystemFactory,
  ) {}

  private getStrategy(gradingModel: string): GradingSystemStrategy {
    return this.gradingSystemFactory.getStrategy(gradingModel);
  }

  async calculateSubjectTermGrade(
    studentId: string,
    subjectId: string,
    termId: string,
  ): Promise<SubjectGradeSummary> {
    const supabase = this.supabaseService.getServiceClient();

    const [subjectRes, assessmentsRes, termRes] = await Promise.all([
      supabase
        .from('subject')
        .select('id, name, code, is_graded')
        .eq('id', subjectId)
        .single(),
      supabase
        .schema('grading')
        .from('assessment')
        .select(
          'id, title, assessment_type, max_score, weight, is_excluded, sort_order, subject_id, term_id',
        )
        .eq('term_id', termId)
        .eq('subject_id', subjectId)
        .order('sort_order', { ascending: true }),
      supabase
        .from('term')
        .select('coursework_weight, exam_weight, academic_year_id')
        .eq('id', termId)
        .single(),
    ]);

    const subject = subjectRes.data;
    const subjectName: string = subject?.name ?? 'Unknown';
    const subjectCode: string = subject?.code ?? null;
    const isGraded: boolean = subject?.is_graded ?? true;

    if (!isGraded) {
      return this.nonGradedResult(subjectId, subjectName, subjectCode);
    }

    if (assessmentsRes.error) {
      this.logger.error(
        `Failed to fetch assessments: ${assessmentsRes.error.message}`,
      );
      return this.emptyGradedResult(subjectId, subjectName, subjectCode);
    }

    const assessments = (assessmentsRes.data ?? []) as AssessmentRecord[];
    if (assessments.length === 0) {
      return this.emptyGradedResult(subjectId, subjectName, subjectCode);
    }

    const assessmentIds = assessments.map((a) => a.id);
    const { data: grades } = await supabase
      .schema('grading')
      .from('grade')
      .select(
        'id, assessment_id, student_id, score, is_excluded, exclusion_reason',
      )
      .eq('student_id', studentId)
      .in('assessment_id', assessmentIds);

    const gradesByAssessmentId = new Map<string, GradeRecord>();
    for (const g of (grades ?? []) as GradeRecord[]) {
      gradesByAssessmentId.set(g.assessment_id, g);
    }

    let gradingModel = 'weighted_continuous';
    if (termRes.data?.academic_year_id) {
      const { data: ay } = await supabase
        .from('academic_year')
        .select('grading_model')
        .eq('id', termRes.data.academic_year_id)
        .single();
      gradingModel = ay?.grading_model ?? 'weighted_continuous';
    }

    const strategy = this.getStrategy(gradingModel);

    const ctx: SubjectTermContext = {
      studentId,
      subjectId,
      subjectName,
      subjectCode,
      termId,
      termWeights: {
        courseworkWeight: termRes.data?.coursework_weight ?? 50,
        examWeight: termRes.data?.exam_weight ?? 50,
      },
      assessments,
      gradesByAssessmentId,
    };

    return strategy.calculateSubjectTermGrade(ctx);
  }

  /**
   * Callers are authorized against `studentGroupId` (class teacher / admin),
   * so a `studentId` must be confined to that class. Without this check a
   * teacher could supply any student id and read their data cross-tenant.
   */
  private async assertStudentInGroup(
    studentId: string,
    studentGroupId: string,
  ): Promise<void> {
    const { data: enrollment } = await this.supabaseService
      .getServiceClient()
      .schema('student')
      .from('student_group_enrollment')
      .select('student_id')
      .eq('student_id', studentId)
      .eq('student_group_id', studentGroupId)
      .maybeSingle();

    if (!enrollment) {
      throw new ForbiddenException('Student is not enrolled in this class');
    }
  }

  async calculateStudentTermResult(
    studentId: string,
    termId: string,
    studentGroupId: string,
  ): Promise<StudentTermResult> {
    await this.assertStudentInGroup(studentId, studentGroupId);

    const supabase = this.supabaseService.getServiceClient();

    const { data: student } = await supabase
      .schema('student')
      .from('student')
      .select('id, first_name, last_name')
      .eq('id', studentId)
      .single();

    if (!student) {
      this.logger.error(`Student not found: ${studentId}`);
      return {
        studentId,
        firstName: 'Unknown',
        lastName: 'Unknown',
        termId,
        subjects: [],
        overallAverage: null,
      };
    }

    const { data: group } = await supabase
      .from('student_group')
      .select('academic_year_id')
      .eq('id', studentGroupId)
      .single();

    const academicYearId = group?.academic_year_id;
    if (!academicYearId) {
      this.logger.error(
        `Student group not found or missing academic year: ${studentGroupId}`,
      );
      return {
        studentId,
        firstName: student.first_name,
        lastName: student.last_name,
        termId,
        subjects: [],
        overallAverage: null,
      };
    }

    const { data: subjectProfiles } = await supabase
      .schema('student')
      .from('student_subject_profile')
      .select('subject_id')
      .eq('student_id', studentId)
      .eq('academic_year_id', academicYearId);

    const subjectIds = (subjectProfiles ?? []).map((sp: any) => sp.subject_id);

    if (subjectIds.length === 0) {
      return {
        studentId,
        firstName: student.first_name,
        lastName: student.last_name,
        termId,
        subjects: [],
        overallAverage: null,
      };
    }

    const { data: subjects } = await supabase
      .from('subject')
      .select('id, name, code, is_graded, sort_order')
      .in('id', subjectIds)
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true });

    const subjectResults: SubjectGradeSummary[] = [];

    for (const subj of subjects ?? []) {
      const id: string = subj.id;
      const name: string = subj.name;
      const code: string = subj.code;

      if (!subj.is_graded) {
        subjectResults.push(this.nonGradedResult(id, name, code));
        continue;
      }

      const result = await this.calculateSubjectTermGrade(
        studentId,
        id,
        termId,
      );
      subjectResults.push(result);
    }

    const gradedComposites = subjectResults
      .filter((s) => s.isGraded && s.termComposite !== null)
      .map((s) => s.termComposite!);

    return {
      studentId,
      firstName: student.first_name,
      lastName: student.last_name,
      termId,
      subjects: subjectResults,
      overallAverage: simpleAverage(gradedComposites),
    };
  }

  async calculateStudentYearResult(
    studentId: string,
    academicYearId: string,
    studentGroupId: string,
  ): Promise<StudentYearResult> {
    await this.assertStudentInGroup(studentId, studentGroupId);

    const supabase = this.supabaseService.getServiceClient();

    const { data: student } = await supabase
      .schema('student')
      .from('student')
      .select('id, first_name, last_name')
      .eq('id', studentId)
      .single();

    const firstName = student?.first_name ?? 'Unknown';
    const lastName = student?.last_name ?? 'Unknown';

    const { data: academicYear } = await supabase
      .from('academic_year')
      .select('id, grading_model, year_exam_weight, year_coursework_weight')
      .eq('id', academicYearId)
      .single();

    const gradingModel =
      (academicYear?.grading_model as GradingModel) ?? 'weighted_continuous';
    const yearExamWeight = academicYear?.year_exam_weight ?? 50;
    const yearCourseworkWeight = academicYear?.year_coursework_weight ?? 50;
    const strategy = this.getStrategy(gradingModel);

    const { data: terms } = await supabase
      .from('term')
      .select('id, name, sort_order')
      .eq('academic_year_id', academicYearId)
      .order('sort_order', { ascending: true });

    if (!terms?.length) {
      return {
        studentId,
        firstName,
        lastName,
        academicYearId,
        gradingModel,
        yearCourseworkWeight,
        yearExamWeight,
        terms: [],
        yearEnd: { subjects: [], overallAverage: null },
      };
    }

    const termResults: {
      termId: string;
      termName: string;
      subjects: SubjectGradeSummary[];
      overallAverage: number | null;
    }[] = [];

    for (const term of terms) {
      const term_id: string = term.id;
      const result = await this.calculateStudentTermResult(
        studentId,
        term_id,
        studentGroupId,
      );
      termResults.push({
        termId: term.id,
        termName: term.name,
        subjects: result.subjects,
        overallAverage: result.overallAverage,
      });
    }

    const termIds = terms.map((t: any) => t.id);
    const { data: allAssessmentsRaw } = await supabase
      .schema('grading')
      .from('assessment')
      .select(
        'id, title, assessment_type, max_score, weight, is_excluded, sort_order, subject_id, term_id',
      )
      .in('term_id', termIds);

    const allAssessments = (allAssessmentsRaw ?? []) as AssessmentRecord[];
    const assessmentIds = allAssessments.map((a) => a.id);

    const gradeIndex = new Map<string, GradeRecord>();
    if (assessmentIds.length > 0) {
      const { data: grades } = await supabase
        .schema('grading')
        .from('grade')
        .select(
          'id, assessment_id, student_id, score, is_excluded, exclusion_reason',
        )
        .eq('student_id', studentId)
        .in('assessment_id', assessmentIds);

      for (const g of (grades ?? []) as GradeRecord[]) {
        gradeIndex.set(`${g.assessment_id}`, g);
      }
    }

    const allSubjectIds = new Set<string>();
    for (const tr of termResults) {
      for (const s of tr.subjects) {
        if (s.isGraded) allSubjectIds.add(s.subjectId);
      }
    }

    const yearEndSubjects: YearEndSubject[] = [];

    for (const subjectId of allSubjectIds) {
      const termSubjectData: TermSubjectData[] = [];
      let subjectName = '';

      for (const tr of termResults) {
        const subj = tr.subjects.find((s) => s.subjectId === subjectId);
        if (subj) subjectName = subj.subjectName;
        termSubjectData.push({
          termId: tr.termId,
          termName: tr.termName,
          termComposite: subj?.termComposite ?? null,
          courseworkAverage: subj?.courseworkAverage ?? null,
          examAverage: subj?.examAverage ?? null,
          assessments: subj?.assessments ?? [],
        });
      }

      const yearCtx: SubjectYearContext = {
        subjectId,
        subjectName,
        yearConfig: {
          yearCourseworkWeight,
          yearExamWeight,
        },
        termSubjectData,
        allAssessments,
        gradeIndex,
      };

      const yearGrade = strategy.calculateYearGrade(yearCtx);
      yearEndSubjects.push({
        subjectId,
        subjectName,
        yearGrade,
        termGrades: termSubjectData.map((t) => ({
          termId: t.termId,
          termName: t.termName,
          termComposite: t.termComposite,
        })),
      });
    }

    const yearGrades = yearEndSubjects
      .map((s) => s.yearGrade)
      .filter((g): g is number => g !== null);

    return {
      studentId,
      firstName,
      lastName,
      academicYearId,
      gradingModel,
      yearCourseworkWeight,
      yearExamWeight,
      terms: termResults,
      yearEnd: {
        subjects: yearEndSubjects,
        overallAverage: simpleAverage(yearGrades),
      },
    };
  }

  async calculateClassTermResults(
    termId: string,
    studentGroupId: string,
  ): Promise<StudentTermResult[]> {
    const cacheKey = `calc:class-term:${studentGroupId}:${termId}`;
    const cached = await this.cache.get(cacheKey);
    if (cached) return cached as StudentTermResult[];

    const supabase = this.supabaseService.getServiceClient();

    const { data: enrollments } = await supabase
      .schema('student')
      .from('student_group_enrollment')
      .select('student_id')
      .eq('student_group_id', studentGroupId);

    if (!enrollments?.length) return [];

    const studentIds = enrollments.map((e: any) => e.student_id);

    const { data: group } = await supabase
      .from('student_group')
      .select('academic_year_id')
      .eq('id', studentGroupId)
      .single();

    const academicYearId = group?.academic_year_id;
    if (!academicYearId) return [];

    const [
      studentsRes,
      termRes,
      subjectProfilesRes,
      allSubjectsRes,
      assessmentsRes,
      academicYearRes,
    ] = await Promise.all([
      supabase
        .schema('student')
        .from('student')
        .select('id, first_name, last_name')
        .in('id', studentIds),
      supabase
        .from('term')
        .select('coursework_weight, exam_weight')
        .eq('id', termId)
        .single(),
      supabase
        .schema('student')
        .from('student_subject_profile')
        .select('student_id, subject_id')
        .in('student_id', studentIds)
        .eq('academic_year_id', academicYearId),
      supabase
        .from('subject')
        .select('id, name, code, is_graded, sort_order')
        .order('sort_order', { ascending: true })
        .order('name', { ascending: true }),
      supabase
        .schema('grading')
        .from('assessment')
        .select(
          'id, title, assessment_type, max_score, weight, is_excluded, sort_order, subject_id, term_id',
        )
        .eq('term_id', termId)
        .order('sort_order', { ascending: true }),
      supabase
        .from('academic_year')
        .select('grading_model')
        .eq('id', academicYearId)
        .single(),
    ]);

    const gradingModel: string =
      academicYearRes.data?.grading_model ?? 'weighted_continuous';
    const strategy = this.getStrategy(gradingModel);

    const studentMap = new Map<
      string,
      { id: string; first_name: string; last_name: string }
    >();

    for (const s of studentsRes.data ?? []) studentMap.set(s.id as string, s);

    const cwWeight = termRes.data?.coursework_weight ?? 50;
    const exWeight = termRes.data?.exam_weight ?? 50;

    const subjectMap = new Map<string, any>();
    for (const s of allSubjectsRes.data ?? [])
      subjectMap.set(s.id as string, s);

    const studentSubjects = new Map<string, Set<string>>();
    for (const sp of subjectProfilesRes.data ?? []) {
      const student_id: string = sp.student_id;

      if (!studentSubjects.has(sp.student_id as string))
        studentSubjects.set(sp.student_id as string, new Set());
      studentSubjects.get(student_id)!.add(sp.subject_id as string);
    }

    const allAssessments = (assessmentsRes.data ?? []) as AssessmentRecord[];
    const assessmentIds = allAssessments.map((a) => a.id);

    let allGrades: GradeRecord[] = [];
    if (assessmentIds.length > 0) {
      const { data: grades } = await supabase
        .schema('grading')
        .from('grade')
        .select(
          'id, assessment_id, student_id, score, is_excluded, exclusion_reason',
        )
        .in('assessment_id', assessmentIds)
        .in('student_id', studentIds);
      allGrades = grades ?? [];
    }

    const gradeIndex = new Map<string, GradeRecord>();
    for (const g of allGrades) {
      gradeIndex.set(`${g.student_id}:${g.assessment_id}`, g);
    }

    const assessmentsBySubject = new Map<string, AssessmentRecord[]>();
    for (const a of allAssessments) {
      if (!assessmentsBySubject.has(a.subject_id))
        assessmentsBySubject.set(a.subject_id, []);
      assessmentsBySubject.get(a.subject_id)!.push(a);
    }

    const results: StudentTermResult[] = [];

    for (const studentId of studentIds) {
      const student = studentMap.get(studentId as string);
      const firstName = student?.first_name ?? 'Unknown';
      const lastName = student?.last_name ?? 'Unknown';
      const mySubjectIds = studentSubjects.get(studentId as string);

      if (!mySubjectIds || mySubjectIds.size === 0) {
        results.push({
          studentId,
          firstName,
          lastName,
          termId,
          subjects: [],
          overallAverage: null,
        });
        continue;
      }

      const subjectResults: SubjectGradeSummary[] = [];

      for (const subjectId of mySubjectIds) {
        const subj = subjectMap.get(subjectId);
        if (!subj) continue;

        if (!subj.is_graded) {
          const subj_name: string = subj.name as string;
          const subj_code: string | null = subj.code as string | null;
          subjectResults.push(
            this.nonGradedResult(subjectId, subj_name, subj_code),
          );
          continue;
        }

        const subjectAssessments = assessmentsBySubject.get(subjectId) ?? [];

        const studentGradeMap = new Map<string, GradeRecord>();
        for (const a of subjectAssessments) {
          const grade = gradeIndex.get(`${studentId}:${a.id}`);
          if (grade) studentGradeMap.set(a.id, grade);
        }

        const ctx: SubjectTermContext = {
          studentId,
          subjectId,
          subjectName: subj.name,
          subjectCode: subj.code,
          termId,
          termWeights: { courseworkWeight: cwWeight, examWeight: exWeight },
          assessments: subjectAssessments,
          gradesByAssessmentId: studentGradeMap,
        };

        subjectResults.push(strategy.calculateSubjectTermGrade(ctx));
      }

      subjectResults.sort((a, b) => {
        const sa = subjectMap.get(a.subjectId)?.sort_order ?? 0;
        const sb = subjectMap.get(b.subjectId)?.sort_order ?? 0;
        return (
          sa - sb ||
          (subjectMap.get(a.subjectId)?.name ?? '').localeCompare(
            subjectMap.get(b.subjectId)?.name ?? '',
          )
        );
      });

      const gradedComposites = subjectResults
        .filter((s) => s.isGraded && s.termComposite !== null)
        .map((s) => s.termComposite!);

      results.push({
        studentId,
        firstName,
        lastName,
        termId,
        subjects: subjectResults,
        overallAverage: simpleAverage(gradedComposites),
      });
    }

    results.sort((a, b) => {
      const avgDiff = (b.overallAverage ?? -1) - (a.overallAverage ?? -1);
      if (avgDiff !== 0) return avgDiff;
      return (a.lastName ?? '').localeCompare(b.lastName ?? '');
    });

    results.forEach((r, i) => {
      r.position = i + 1;
    });

    await this.cache.set(cacheKey, results, CALC_TTL);
    return results;
  }

  async calculateClassYearResults(
    academicYearId: string,
    studentGroupId: string,
  ): Promise<StudentYearResult[]> {
    const cacheKey = `calc:class-year:${studentGroupId}:${academicYearId}`;
    const cached = await this.cache.get(cacheKey);
    if (cached) return cached as StudentYearResult[];

    const supabase = this.supabaseService.getServiceClient();

    const { data: enrollments } = await supabase
      .schema('student')
      .from('student_group_enrollment')
      .select('student_id')
      .eq('student_group_id', studentGroupId);

    if (!enrollments?.length) return [];

    const studentIds = enrollments.map((e: any) => e.student_id);

    const [
      studentsRes,
      academicYearRes,
      termsRes,
      subjectProfilesRes,
      allSubjectsRes,
    ] = await Promise.all([
      supabase
        .schema('student')
        .from('student')
        .select('id, first_name, last_name')
        .in('id', studentIds),
      supabase
        .from('academic_year')
        .select('id, grading_model, year_exam_weight, year_coursework_weight')
        .eq('id', academicYearId)
        .single(),
      supabase
        .from('term')
        .select('id, name, sort_order, coursework_weight, exam_weight')
        .eq('academic_year_id', academicYearId)
        .order('sort_order', { ascending: true }),
      supabase
        .schema('student')
        .from('student_subject_profile')
        .select('student_id, subject_id')
        .in('student_id', studentIds)
        .eq('academic_year_id', academicYearId),
      supabase
        .from('subject')
        .select('id, name, code, is_graded, sort_order')
        .order('sort_order', { ascending: true })
        .order('name', { ascending: true }),
    ]);

    const studentMap = new Map<
      string,
      { id: string; first_name: string; last_name: string }
    >();
    for (const s of studentsRes.data ?? []) studentMap.set(s.id as string, s);

    const gradingModel =
      (academicYearRes.data?.grading_model as GradingModel) ??
      'weighted_continuous';
    const yearExamWeight = academicYearRes.data?.year_exam_weight ?? 50;
    const yearCourseworkWeight =
      academicYearRes.data?.year_coursework_weight ?? 50;
    const strategy = this.getStrategy(gradingModel);

    const terms = termsRes.data ?? [];
    if (terms.length === 0) return [];

    const subjectMap = new Map<string, any>();
    for (const s of allSubjectsRes.data ?? [])
      subjectMap.set(s.id as string, s);

    const studentSubjects = new Map<string, Set<string>>();
    for (const sp of subjectProfilesRes.data ?? []) {
      const student_id: string = sp.student_id;

      if (!studentSubjects.has(student_id))
        studentSubjects.set(student_id, new Set());
      studentSubjects.get(student_id)!.add(sp.subject_id as string);
    }

    const termIds = terms.map((t: any) => t.id);

    const { data: allAssessmentsRaw } = await supabase
      .schema('grading')
      .from('assessment')
      .select(
        'id, title, assessment_type, max_score, weight, is_excluded, sort_order, subject_id, term_id',
      )
      .in('term_id', termIds)
      .order('sort_order', { ascending: true });

    const allAssessments = (allAssessmentsRaw ?? []) as AssessmentRecord[];
    const assessmentIds = allAssessments.map((a) => a.id);

    let allGrades: GradeRecord[] = [];
    if (assessmentIds.length > 0) {
      const { data: grades } = await supabase
        .schema('grading')
        .from('grade')
        .select(
          'id, assessment_id, student_id, score, is_excluded, exclusion_reason',
        )
        .in('assessment_id', assessmentIds)
        .in('student_id', studentIds);
      allGrades = grades ?? [];
    }

    const gradeIndex = new Map<string, GradeRecord>();
    for (const g of allGrades)
      gradeIndex.set(`${g.student_id}:${g.assessment_id}`, g);

    const assessmentsByTermSubject = new Map<string, AssessmentRecord[]>();
    for (const a of allAssessments) {
      const key = `${a.term_id}:${a.subject_id}`;
      if (!assessmentsByTermSubject.has(key))
        assessmentsByTermSubject.set(key, []);
      assessmentsByTermSubject.get(key)!.push(a);
    }

    const termWeightMap = new Map<string, { cw: number; ex: number }>();
    for (const t of terms)
      termWeightMap.set(t.id as string, {
        cw: t.coursework_weight ?? 50,
        ex: t.exam_weight ?? 50,
      });

    const computeSubjectTerm = (
      studentId: string,
      subjectId: string,
      termId: string,
    ): SubjectGradeSummary => {
      const subj = subjectMap.get(subjectId);
      if (!subj || !subj.is_graded) {
        const subj_name: string = subj?.name ?? 'Unknown';
        const subj_code: string = subj?.code ?? null;

        return this.nonGradedResult(subjectId, subj_name, subj_code);
      }

      const subjectAssessments =
        assessmentsByTermSubject.get(`${termId}:${subjectId}`) ?? [];
      const tw = termWeightMap.get(termId) ?? { cw: 50, ex: 50 };

      const studentGradeMap = new Map<string, GradeRecord>();
      for (const a of subjectAssessments) {
        const grade = gradeIndex.get(`${studentId}:${a.id}`);
        if (grade) studentGradeMap.set(a.id, grade);
      }

      const ctx: SubjectTermContext = {
        studentId,
        subjectId,
        subjectName: subj.name,
        subjectCode: subj.code,
        termId,
        termWeights: { courseworkWeight: tw.cw, examWeight: tw.ex },
        assessments: subjectAssessments,
        gradesByAssessmentId: studentGradeMap,
      };

      return strategy.calculateSubjectTermGrade(ctx);
    };

    const results: StudentYearResult[] = [];

    for (const studentId of studentIds) {
      const student = studentMap.get(studentId as string);
      const firstName = student?.first_name ?? 'Unknown';
      const lastName = student?.last_name ?? 'Unknown';
      const mySubjectIds = studentSubjects.get(studentId as string);

      if (!mySubjectIds || mySubjectIds.size === 0) {
        results.push({
          studentId,
          firstName,
          lastName,
          academicYearId,
          gradingModel,
          yearCourseworkWeight,
          yearExamWeight,
          terms: terms.map((t: any) => ({
            termId: t.id,
            termName: t.name,
            subjects: [],
            overallAverage: null,
          })),
          yearEnd: { subjects: [], overallAverage: null },
        });
        continue;
      }

      const termResults: {
        termId: string;
        termName: string;
        subjects: SubjectGradeSummary[];
        overallAverage: number | null;
      }[] = [];

      for (const term of terms) {
        const subjectResults: SubjectGradeSummary[] = [];
        for (const subjectId of mySubjectIds) {
          const term_id: string = term.id;

          subjectResults.push(
            computeSubjectTerm(studentId as string, subjectId, term_id),
          );
        }
        subjectResults.sort((a, b) => {
          const sa = subjectMap.get(a.subjectId)?.sort_order ?? 0;
          const sb = subjectMap.get(b.subjectId)?.sort_order ?? 0;
          return (
            sa - sb ||
            (subjectMap.get(a.subjectId)?.name ?? '').localeCompare(
              subjectMap.get(b.subjectId)?.name ?? '',
            )
          );
        });

        const gradedComposites = subjectResults
          .filter((s) => s.isGraded && s.termComposite !== null)
          .map((s) => s.termComposite!);
        termResults.push({
          termId: term.id,
          termName: term.name,
          subjects: subjectResults,
          overallAverage: simpleAverage(gradedComposites),
        });
      }

      const allSubjectIdSet = new Set<string>();
      for (const tr of termResults)
        for (const s of tr.subjects)
          if (s.isGraded) allSubjectIdSet.add(s.subjectId);

      const studentGradeIndex = new Map<string, GradeRecord>();
      for (const g of allGrades) {
        if (g.student_id === studentId) {
          studentGradeIndex.set(`${g.assessment_id}`, g);
        }
      }

      const yearEndSubjects: YearEndSubject[] = [];
      for (const subjectId of allSubjectIdSet) {
        const termSubjectData: TermSubjectData[] = [];
        let subjectName = '';
        for (const tr of termResults) {
          const subj = tr.subjects.find((s) => s.subjectId === subjectId);
          if (subj) subjectName = subj.subjectName;
          termSubjectData.push({
            termId: tr.termId,
            termName: tr.termName,
            termComposite: subj?.termComposite ?? null,
            courseworkAverage: subj?.courseworkAverage ?? null,
            examAverage: subj?.examAverage ?? null,
            assessments: subj?.assessments ?? [],
          });
        }

        const yearCtx: SubjectYearContext = {
          subjectId,
          subjectName,
          yearConfig: { yearCourseworkWeight, yearExamWeight },
          termSubjectData,
          allAssessments,
          gradeIndex: studentGradeIndex,
        };

        const yearGrade = strategy.calculateYearGrade(yearCtx);
        yearEndSubjects.push({
          subjectId,
          subjectName,
          yearGrade,
          termGrades: termSubjectData.map((t) => ({
            termId: t.termId,
            termName: t.termName,
            termComposite: t.termComposite,
          })),
        });
      }

      const yearGrades = yearEndSubjects
        .map((s) => s.yearGrade)
        .filter((g): g is number => g !== null);

      results.push({
        studentId,
        firstName,
        lastName,
        academicYearId,
        gradingModel,
        yearCourseworkWeight,
        yearExamWeight,
        terms: termResults,
        yearEnd: {
          subjects: yearEndSubjects,
          overallAverage: simpleAverage(yearGrades),
        },
      });
    }

    results.sort((a, b) => {
      const avgDiff =
        (b.yearEnd.overallAverage ?? -1) - (a.yearEnd.overallAverage ?? -1);
      if (avgDiff !== 0) return avgDiff;
      return (a.lastName ?? '').localeCompare(b.lastName ?? '');
    });

    results.forEach((r, i) => {
      r.position = i + 1;
    });

    await this.cache.set(cacheKey, results, CALC_TTL);
    return results;
  }

  private nonGradedResult(
    subjectId: string,
    subjectName: string,
    subjectCode: string | null,
  ): SubjectGradeSummary {
    return {
      subjectId,
      subjectName,
      subjectCode,
      isGraded: false,
      courseworkAverage: null,
      examAverage: null,
      termComposite: null,
      gradeCount: 0,
      assessments: [],
    };
  }

  private emptyGradedResult(
    subjectId: string,
    subjectName: string,
    subjectCode: string | null,
  ): SubjectGradeSummary {
    return {
      subjectId,
      subjectName,
      subjectCode,
      isGraded: true,
      courseworkAverage: null,
      examAverage: null,
      termComposite: null,
      gradeCount: 0,
      assessments: [],
    };
  }
}
