import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AuthGuard } from '@/auth/auth.guard';
import { PermissionGuard } from '@/permission/permission.guard';
import { RequirePermission } from '@/permission/require-permission.decorator';
import { ClassTeacherGuard } from '@/class/class-teacher.guard';
import { ReportGuard } from './report.guard';
import { VersioningService } from '@/versioning/versioning.service';
import { ReportService } from './report.service';
import { GenerateReportDto } from './dto/generate-report.dto';
import { UpdateReportDto } from './dto/update-report.dto';
import { UpdateReportEntryDto } from './dto/update-report-entry.dto';
import { SavePdfDto } from './dto/save-pdf.dto';
@ApiTags('Reports')
@ApiBearerAuth()
@Controller('reports')
@UseGuards(AuthGuard, PermissionGuard)
export class ReportController {
  constructor(
    private readonly reportService: ReportService,
    private readonly versioning: VersioningService,
  ) {}

  @RequirePermission('reporting', 'create')
  @Post('generate')
  @UseGuards(ClassTeacherGuard)
  async generate(@Req() req: any, @Body() dto: GenerateReportDto) {
    const userId: string = req.user.id;
    const raw = await this.reportService.generateTermReports(userId, dto);
    return this.versioning.resolve(req, 'report.generated')(raw);
  }

  @RequirePermission('reporting', 'read')
  @Get()
  @UseGuards(ClassTeacherGuard)
  async findByClassAndTerm(
    @Query('studentGroupId') studentGroupId: string,
    @Query('termId') termId: string,
    @Query('reportType') reportType: string | undefined,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const raw = await this.reportService.findByClassAndTerm(
      studentGroupId,
      termId,
      req,
      reply,
      reportType,
    );
    return this.versioning.resolve(req, 'report.list')(raw);
  }

  @RequirePermission('reporting', 'read')
  @Get('class-summary')
  @UseGuards(ClassTeacherGuard)
  async getClassSummary(
    @Query('studentGroupId') studentGroupId: string,
    @Query('termId') termId: string,
    @Query('reportType') reportType: string,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const raw = await this.reportService.getClassSummary(
      studentGroupId,
      termId,
      reportType,
      req,
      reply,
    );
    return this.versioning.resolve(req, 'report.classSummary')(raw);
  }

  @RequirePermission('reporting', 'read')
  @Get('class-summary/analytics')
  @UseGuards(ClassTeacherGuard)
  async getGradeAnalytics(
    @Query('studentGroupId') studentGroupId: string,
    @Query('termId') termId: string,
    @Query('reportType') reportType: string,
  ) {
    return this.reportService.getGradeAnalytics(
      studentGroupId,
      termId,
      reportType,
    );
  }

  @RequirePermission('reporting', 'read')
  @Get('class-summary/download')
  @UseGuards(ClassTeacherGuard)
  async downloadClassSummaryFile(
    @Query('studentGroupId') studentGroupId: string,
    @Query('termId') termId: string,
    @Query('reportType') reportType: string,
    @Query('fileType') fileType: string,
    @Res() reply: FastifyReply,
  ) {
    const { buffer, filename, contentType } =
      await this.reportService.downloadClassSummaryFile(
        studentGroupId,
        termId,
        reportType,
        fileType,
      );
    reply
      .header('Content-Type', contentType)
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .header('Content-Length', buffer.length)
      .send(buffer);
  }

  @RequirePermission('reporting', 'read')
  @Get('class-summary/files')
  @UseGuards(ClassTeacherGuard)
  async getClassSummaryFiles(
    @Query('studentGroupId') studentGroupId: string,
    @Query('termId') termId: string,
    @Query('reportType') reportType: string,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const raw = await this.reportService.getClassSummaryFiles(
      studentGroupId,
      termId,
      reportType,
      req,
      reply,
    );
    return this.versioning.resolve(req, 'report.classSummaryFiles')(raw);
  }

  @RequirePermission('reporting', 'read')
  @Get('student')
  @UseGuards(ClassTeacherGuard)
  async findStudentReport(
    @Query('studentId') studentId: string,
    @Query('termId') termId: string,
    @Query('reportType') reportType: string,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const raw = await this.reportService.findStudentReport(
      studentId,
      termId,
      reportType,
      req,
      reply,
    );
    return this.versioning.resolve(req, 'report.studentReport')(raw);
  }

  @RequirePermission('reporting', 'read')
  @Get(':id/pdfs')
  @UseGuards(ClassTeacherGuard)
  async getPdfHistory(
    @Param('id') id: string,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const raw = await this.reportService.getPdfHistory(id, req, reply);
    return this.versioning.resolve(req, 'report.pdfHistory')(raw);
  }

  @RequirePermission('reporting', 'read')
  @Get(':id/pdf/latest')
  @UseGuards(ClassTeacherGuard)
  async getLatestPdf(
    @Param('id') id: string,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const raw = await this.reportService.getLatestPdf(id, req, reply);
    return this.versioning.resolve(req, 'report.pdfLatest')(raw);
  }

  @RequirePermission('reporting', 'read')
  @Get(':id')
  @UseGuards(ClassTeacherGuard)
  async findOne(
    @Param('id') id: string,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const raw = await this.reportService.findOne(id, req, reply);
    return this.versioning.resolve(req, 'report.detail')(raw);
  }

  @RequirePermission('reporting', 'update')
  @Patch(':id')
  @UseGuards(ClassTeacherGuard, ReportGuard)
  async updateReport(
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: UpdateReportDto,
  ) {
    const userId: string = req.user.id;
    const raw = await this.reportService.updateReport(userId, id, dto);
    return this.versioning.resolve(req, 'report.updated')(raw);
  }

  @RequirePermission('reporting', 'update')
  @Patch(':id/regenerate')
  @UseGuards(ClassTeacherGuard, ReportGuard)
  async regenerate(@Req() req: any, @Param('id') id: string) {
    const userId: string = req.user.id;
    const raw = await this.reportService.regenerateReport(userId, id);
    return this.versioning.resolve(req, 'report.updated')(raw);
  }

  @RequirePermission('reporting', 'update')
  @Patch(':id/publish')
  @UseGuards(ClassTeacherGuard, ReportGuard)
  async publish(@Req() req: any, @Param('id') id: string) {
    const userId: string = req.user.id;
    const raw = await this.reportService.publish(userId, id);
    return this.versioning.resolve(req, 'report.updated')(raw);
  }

  @RequirePermission('reporting', 'update')
  @Patch(':id/send-to-ministry')
  @UseGuards(ClassTeacherGuard)
  async sendToMinistry(@Req() req: any, @Param('id') id: string) {
    const userId: string = req.user.id;
    const raw = await this.reportService.sendToMinistry(userId, id);
    return this.versioning.resolve(req, 'report.updated')(raw);
  }

  @RequirePermission('reporting', 'create')
  @Post(':id/pdf')
  @UseGuards(ClassTeacherGuard, ReportGuard)
  async savePdf(
    @Param('id') id: string,
    @Req() req: any,
    @Body() dto: SavePdfDto,
  ) {
    const userId: string = req.user.id;
    const raw = await this.reportService.savePdf(id, userId, dto);
    return this.versioning.resolve(req, 'report.pdfSaved')(raw);
  }

  @RequirePermission('reporting', 'create')
  @Post(':id/pdf/upload')
  @UseGuards(ClassTeacherGuard, ReportGuard)
  async uploadPdf(@Param('id') id: string, @Req() req: any) {
    const file = await req.file();
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }

    const buffer: Buffer = await file.toBuffer();
    if (!buffer.length) {
      throw new BadRequestException('Empty file');
    }

    const userId: string = req.user.id;
    const raw = await this.reportService.uploadPdf(id, userId, buffer);
    return this.versioning.resolve(req, 'report.pdfUploaded')(raw);
  }

  @RequirePermission('reporting', 'read')
  @Get(':id/pdf/:pdfId/download')
  @UseGuards(ClassTeacherGuard)
  async downloadPdf(
    @Param('id') id: string,
    @Param('pdfId') pdfId: string,
    @Res() reply: FastifyReply,
  ) {
    const { buffer, filename } = await this.reportService.downloadPdf(
      id,
      pdfId,
    );
    reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .header('Content-Length', buffer.length)
      .send(buffer);
  }
}

@ApiTags('Report entries')
@ApiBearerAuth()
@Controller('report-entries')
@UseGuards(AuthGuard, PermissionGuard)
export class ReportEntriesController {
  constructor(
    private readonly reportService: ReportService,
    private readonly versioning: VersioningService,
  ) {}

  @RequirePermission('reporting', 'update')
  @Patch(':entryId')
  @UseGuards(ReportGuard)
  async updateEntry(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param('entryId') entryId: string,
    @Body() dto: UpdateReportEntryDto,
  ) {
    const raw = await this.reportService.updateReportEntry(
      entryId,
      dto,
      req,
      reply,
    );
    return this.versioning.resolve(req, 'reportEntry.updated')(raw);
  }
}
