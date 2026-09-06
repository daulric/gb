import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Patch,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AuthService } from './auth.service';
import { AuthGuard } from './auth.guard';
import { ImagesService } from '@/images/images.service';
import { SendOtpDto } from '@/auth/dto/send-otp.dto';
import { VerifyOtpDto } from '@/auth/dto/verify-otp.dto';
import { OnboardDto } from '@/auth/dto/onboard.dto';
import { UpdateProfileDto } from '@/auth/dto/update-profile.dto';
import { CreateResumableUploadDto } from '@/images/dto/create-resumable-upload.dto';
import { CompleteUploadDto } from '@/images/dto/complete-upload.dto';
import { SupabaseService } from '@/supabase/supabase.service';
import { VersioningService } from '@/versioning/versioning.service';
import { MultipartFile } from '@fastify/multipart';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly imagesService: ImagesService,
    private readonly supabaseService: SupabaseService,
    private readonly versioning: VersioningService,
  ) {}

  @Post('otp/send')
  @Throttle({ 'auth-strict': { limit: 5, ttl: 60 * 60 * 1000 } })
  async sendOtp(@Body() dto: SendOtpDto, @Req() req: any) {
    const message = await this.authService.sendOtp(dto.email);
    return this.versioning.resolve(req, 'auth.message')(message);
  }

  @Post('otp/verify')
  @Throttle({ 'auth-strict': { limit: 10, ttl: 15 * 60 * 1000 } })
  async verifyOtp(
    @Body() dto: VerifyOtpDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) res: FastifyReply,
  ) {
    const { session, user, profile } = await this.authService.verifyOtp(
      dto.email,
      dto.token,
      req,
      res,
    );

    return this.versioning.resolve(req, 'auth.verifyOtp')(
      session,
      user,
      profile,
    );
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Get('me')
  async me(@Req() req: any) {
    const userId: string = req.user.id;
    const raw = await this.authService.getProfile(userId);
    return this.versioning.resolve(req, 'auth.profile')(raw);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Patch('onboard')
  async onboard(@Req() req: any, @Body() dto: OnboardDto) {
    const userId: string = req.user.id;
    const raw = await this.authService.onboard(userId, dto);
    return this.versioning.resolve(req, 'auth.profile')(raw);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Patch('profile')
  async updateProfile(@Req() req: any, @Body() dto: UpdateProfileDto) {
    const userId: string = req.user.id;
    const raw = await this.authService.updateProfile(userId, dto);
    return this.versioning.resolve(req, 'auth.profile')(raw);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Delete('account')
  @Throttle({ default: { limit: 3, ttl: 60 * 60 * 1000 } })
  async deleteAccount(@Req() req: any) {
    const userId: string = req.user.id;
    const message = await this.authService.deleteAccount(userId);
    return this.versioning.resolve(req, 'auth.message')(message);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Post('logout')
  async logout(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<string> {
    await this.supabaseService.signOut(req, res);
    return this.versioning.resolve(req, 'auth.message')('Logged out');
  }

  // ── Avatar ───────────────────────────────────────────────────────────

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Get('avatar')
  @ApiProduces('image/*')
  async getAvatar(@Req() req: any, @Res() res: FastifyReply) {
    const userId: string = req.user.id;
    const { blob, contentType } =
      await this.imagesService.getImageFromUserProfile(userId);

    const buffer = Buffer.from(await blob.arrayBuffer());

    return res
      .header('Content-Type', contentType)
      .header('Content-Length', buffer.length)
      .header('Cache-Control', 'private, max-age=3600')
      .send(buffer);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Post('avatar')
  @ApiConsumes('multipart/form-data')
  async uploadAvatar(@Req() req: any) {
    const file: MultipartFile = await req.file();

    if (!file) {
      throw new BadRequestException('No file provided');
    }

    const userId: string = req.user.id;

    const result = await this.imagesService.setImageToUserProfile(userId, file);
    return this.versioning.resolve(req, 'images.uploaded')(result);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Post('avatar/resumable')
  async createResumableUpload(
    @Req() req: any,
    @Body() dto: CreateResumableUploadDto,
  ) {
    const userId: string = req.user.id;
    const result = await this.imagesService.createResumableUpload(
      userId,
      dto.filename,
      dto.contentType,
      dto.totalSize,
    );
    return this.versioning.resolve(req, 'images.resumable')(result);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Post('avatar/complete')
  async completeResumableUpload(
    @Req() req: any,
    @Body() dto: CompleteUploadDto,
  ) {
    const userId: string = req.user.id;
    const result = await this.imagesService.completeResumableUpload(
      userId,
      dto.path,
    );
    return this.versioning.resolve(req, 'images.uploaded')(result);
  }
}
