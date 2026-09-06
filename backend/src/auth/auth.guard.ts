import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { SupabaseService } from '@/supabase/supabase.service';
import { FastifyReply, FastifyRequest } from 'fastify';

@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name);

  constructor(private readonly supabaseService: SupabaseService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request: FastifyRequest = http.getRequest();
    const reply: FastifyReply = http.getResponse();

    try {
      const user = await this.supabaseService.getUser(request, reply);

      if (!user) {
        throw new UnauthorizedException('Invalid or expired session');
      }

      const { data: profile } = await this.supabaseService
        .getServiceClient()
        .from('user_profile')
        .select('is_active')
        .eq('id', user.id)
        .maybeSingle();

      if (profile && profile.is_active === false) {
        throw new UnauthorizedException('Account is deactivated');
      }

      request.user = {
        id: user.id,
        email: user.email,
      };

      return true;
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      this.logger.error(`Unexpected error in AuthGuard: ${String(err)}`);
      throw new UnauthorizedException('Invalid or expired session');
    }
  }
}
