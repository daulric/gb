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
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { AuthGuard } from '@/auth/auth.guard';
import { PermissionGuard } from '@/permission/permission.guard';
import { RequirePermission } from '@/permission/require-permission.decorator';
import { FileManagerService } from './file-manager.service';
import { FileNotificationService } from './file-notification.service';
import { FolderService } from './folder.service';
import { ListFilesQueryDto } from './dto/list-files.query.dto';
import { RenameFileDto } from './dto/rename-file.dto';
import { ShareFileDto } from './dto/share-file.dto';
import { UpdateShareDto } from './dto/update-share.dto';
import { CreateFolderDto } from './dto/create-folder.dto';
import { RenameFolderDto } from './dto/rename-folder.dto';
import { MoveFileDto } from './dto/move-file.dto';
import { MoveFolderDto } from './dto/move-folder.dto';
import { BrowseFolderQueryDto } from './dto/browse-folder.query.dto';
import { MultipartFile } from '@fastify/multipart';

@ApiTags('File Manager')
@ApiBearerAuth()
@Controller('files')
@UseGuards(AuthGuard, PermissionGuard)
export class FileManagerController {
  constructor(
    private readonly files: FileManagerService,
    private readonly notifications: FileNotificationService,
    private readonly folders: FolderService,
  ) {}

  @RequirePermission('file', 'read')
  @Get()
  async list(@Req() req: any, @Query() query: ListFilesQueryDto) {
    const userId: string = req.user.id;
    return this.files.list(userId, query.filter, {
      page: query.page,
      pageSize: query.pageSize,
    });
  }

  @RequirePermission('file', 'create')
  @Post()
  @ApiConsumes('multipart/form-data')
  async upload(
    @Req() req: any,
    @Query('name') name?: string,
    @Query('folderId') folderId?: string,
  ) {
    const userId: string = req.user.id;
    const file: MultipartFile = await req.file();
    return this.files.uploadManual(userId, file, name, folderId);
  }

  // ── Folders (declared before :id so the literal path wins) ────────────────

  @RequirePermission('file', 'read')
  @Get('folders/contents')
  async browseFolder(@Req() req: any, @Query() query: BrowseFolderQueryDto) {
    const userId: string = req.user.id;
    return this.files.browseFolder(userId, query.folderId ?? null);
  }

  @RequirePermission('file', 'read')
  @Get('folders')
  async listFolders(@Req() req: any) {
    const userId: string = req.user.id;
    return this.folders.listAll(userId);
  }

  @RequirePermission('file', 'create')
  @Post('folders')
  async createFolder(@Req() req: any, @Body() dto: CreateFolderDto) {
    const userId: string = req.user.id;
    return this.folders.create(userId, dto.name, dto.parentId ?? null);
  }

  @RequirePermission('file', 'update')
  @Patch('folders/:folderId')
  async renameFolder(
    @Req() req: any,
    @Param('folderId') folderId: string,
    @Body() dto: RenameFolderDto,
  ) {
    const userId: string = req.user.id;
    return this.folders.rename(userId, folderId, dto.name);
  }

  /** Re-parent a folder (drag a folder into another folder, or to the root). */
  @RequirePermission('file', 'update')
  @Patch('folders/:folderId/move')
  async moveFolder(
    @Req() req: any,
    @Param('folderId') folderId: string,
    @Body() dto: MoveFolderDto,
  ) {
    const userId: string = req.user.id;
    return this.folders.move(userId, folderId, dto.parentId);
  }

  @RequirePermission('file', 'delete')
  @Delete('folders/:folderId')
  async deleteFolder(@Req() req: any, @Param('folderId') folderId: string) {
    const userId: string = req.user.id;
    return this.folders.remove(userId, folderId);
  }

  // ── Notifications (declared before :id so the literal path wins) ──────────

  @RequirePermission('file', 'read')
  @Get('notifications')
  async listNotifications(@Req() req: any) {
    const userId: string = req.user.id;
    return this.notifications.list(userId);
  }

  @RequirePermission('file', 'read')
  @Get('notifications/unread-count')
  async unreadNotifications(@Req() req: any) {
    const userId: string = req.user.id;
    return this.notifications.unreadCount(userId);
  }

  @RequirePermission('file', 'read')
  @Post('notifications/mark-read')
  async markNotificationsRead(@Req() req: any) {
    const userId: string = req.user.id;
    return this.notifications.markAllRead(userId);
  }

  @RequirePermission('file', 'read')
  @Get(':id')
  async metadata(@Req() req: any, @Param('id') id: string) {
    const userId: string = req.user.id;
    return this.files.getMetadata(userId, id);
  }

  @RequirePermission('file', 'read')
  @Get(':id/content')
  async view(
    @Req() req: any,
    @Param('id') id: string,
    @Res() reply: FastifyReply,
  ) {
    const userId: string = req.user.id;
    const { buffer, contentType, filename } = await this.files.getViewContent(
      userId,
      id,
    );
    reply
      .header('Content-Type', contentType)
      .header(
        'Content-Disposition',
        `inline; filename="${this.encode(filename)}"`,
      )
      .header('Content-Length', buffer.length)
      .header('Cache-Control', 'private, no-store')
      .send(buffer);
  }

  /** Download — only for the owner or a recipient with download rights. */
  @RequirePermission('file', 'read')
  @Get(':id/download')
  async download(
    @Req() req: any,
    @Param('id') id: string,
    @Res() reply: FastifyReply,
  ) {
    const userId: string = req.user.id;
    const { buffer, contentType, filename } =
      await this.files.getDownloadContent(userId, id);
    reply
      .header('Content-Type', contentType)
      .header(
        'Content-Disposition',
        `attachment; filename="${this.encode(filename)}"`,
      )
      .header('Content-Length', buffer.length)
      .header('Cache-Control', 'private, no-store')
      .send(buffer);
  }

  @RequirePermission('file', 'update')
  @Patch(':id')
  async rename(
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: RenameFileDto,
  ) {
    const userId: string = req.user.id;
    return this.files.rename(userId, id, dto.name);
  }

  /** Move a file into a folder (or to the root with `folderId: null`). */
  @RequirePermission('file', 'update')
  @Patch(':id/move')
  async move(
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: MoveFileDto,
  ) {
    const userId: string = req.user.id;
    return this.files.move(userId, id, dto.folderId);
  }

  @RequirePermission('file', 'delete')
  @Delete(':id')
  async remove(@Req() req: any, @Param('id') id: string) {
    const userId: string = req.user.id;
    return this.files.softDelete(userId, id);
  }

  // ── Shares (owner only; ownership enforced in the service) ─────────────────

  @RequirePermission('file', 'update')
  @Get(':id/shares')
  async listShares(@Req() req: any, @Param('id') id: string) {
    const userId: string = req.user.id;
    return this.files.listShares(userId, id);
  }

  @RequirePermission('file', 'update')
  @Post(':id/shares')
  async share(
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: ShareFileDto,
  ) {
    const userId: string = req.user.id;
    return this.files.share(userId, id, dto.shares);
  }

  @RequirePermission('file', 'update')
  @Patch(':id/shares/:shareId')
  async updateShare(
    @Req() req: any,
    @Param('id') id: string,
    @Param('shareId') shareId: string,
    @Body() dto: UpdateShareDto,
  ) {
    const userId: string = req.user.id;
    return this.files.updateShare(userId, id, shareId, dto.canDownload);
  }

  @RequirePermission('file', 'update')
  @Delete(':id/shares/:shareId')
  async revokeShare(
    @Req() req: any,
    @Param('id') id: string,
    @Param('shareId') shareId: string,
  ) {
    const userId: string = req.user.id;
    return this.files.revokeShare(userId, id, shareId);
  }

  /** RFC 5987-safe filename for the Content-Disposition header. */
  private encode(name: string): string {
    return name.replace(/["\\\r\n]/g, '_');
  }
}
