import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '@/supabase/supabase.service';
import { ChatRealtimeService } from './chat-realtime.service';
import { MessageCipher } from './message-cipher.service';
import { ChatEventType, channelsEnabled } from './chat.constants';
import type {
  ChatConversation,
  ChatMessage,
  ChatParticipant,
} from './chat.types';

const MESSAGE_COLUMNS =
  'id, conversation_id, sender_id, type, body, metadata, action_state, created_at, edited_at, deleted_at';
const CONVERSATION_COLUMNS =
  'id, school_id, type, title, direct_key, created_by, created_at, last_message_at';

interface ConversationRow {
  id: string;
  school_id: string;
  type: 'direct' | 'channel';
  title: string | null;
  direct_key: string | null;
  created_by: string | null;
  created_at: string;
  last_message_at: string;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  sender_id: string;
  type: ChatMessage['type'];
  body: string | null;
  metadata: Record<string, unknown> | null;
  action_state: ChatMessage['actionState'];
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
}

/**
 * Direct messaging between users of the same school, plus a feature-flagged
 * base for channels. Postgres is the source of truth; every write also fans a
 * realtime event out over the Redis bus (see ChatRealtimeService).
 */
@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly realtime: ChatRealtimeService,
    private readonly cipher: MessageCipher,
  ) {}

  // ── Users you can message ──────────────────────────────────────────────────

  /** Active users in the caller's school, excluding the caller. */
  async listMessageableUsers(userId: string): Promise<ChatParticipant[]> {
    const schoolId = await this.supabase.getUserSchoolId(userId);
    const { data } = await this.supabase
      .getServiceClient()
      .from('user_profile')
      .select('id, first_name, last_name, avatar_url')
      .eq('school_id', schoolId)
      .eq('is_active', true)
      .neq('id', userId)
      .order('first_name', { ascending: true });

    return (data ?? []).map((p: any) => ({
      userId: p.id,
      firstName: p.first_name,
      lastName: p.last_name,
      avatarUrl: p.avatar_url,
    }));
  }

  // ── Conversations ──────────────────────────────────────────────────────────

  /** The caller's conversations, most-recent first, with previews + unread. */
  async listConversations(userId: string): Promise<ChatConversation[]> {
    const client = this.supabase.getServiceClient();

    const { data: memberships } = await client
      .schema('chat')
      .from('conversation_member')
      .select('conversation_id, last_read_at')
      .eq('user_id', userId);

    const ids: string[] = (memberships ?? []).map(
      (m: { conversation_id: string }) => m.conversation_id,
    );

    if (ids.length === 0) return [];

    const { data: conversations } = await client
      .schema('chat')
      .from('conversation')
      .select(CONVERSATION_COLUMNS)
      .in('id', ids)
      .order('last_message_at', { ascending: false });

    const rows = (conversations ?? []) as ConversationRow[];
    const membershipRows = (memberships ?? []) as {
      conversation_id: string;
      last_read_at: string | null;
    }[];

    // Unread counts for the whole set resolve in one round-trip (RPC) rather
    // than one COUNT query per conversation. Participants likewise batch.
    const [participantsByConversation, unreadByConversation] =
      await Promise.all([
        this.participantsFor(ids),
        this.unreadCountsFor(userId, membershipRows),
      ]);

    // Message previews are still fetched per-conversation (in parallel); a
    // windowed DISTINCT-ON RPC would collapse these too if it becomes hot.
    return Promise.all(
      rows.map(async (conv) => {
        const lastMessage = await this.lastMessageFor(conv.id);
        return this.presentConversation(
          conv,
          participantsByConversation.get(conv.id) ?? [],
          lastMessage,
          unreadByConversation.get(conv.id) ?? 0,
        );
      }),
    );
  }

  /** Start (or reuse) a direct conversation with another school member. */
  async getOrCreateDirect(
    userId: string,
    otherUserId: string,
  ): Promise<ChatConversation> {
    if (otherUserId === userId) {
      throw new BadRequestException('You cannot message yourself');
    }

    const schoolId = await this.supabase.getUserSchoolId(userId);
    const otherSchoolId = await this.resolveSchool(otherUserId);
    if (otherSchoolId !== schoolId) {
      throw new ForbiddenException('That user is not in your school');
    }

    const directKey = ChatService.directKey(userId, otherUserId);
    const client = this.supabase.getServiceClient();

    const existing = await this.findDirect(schoolId, directKey);
    if (existing) return this.summarize(existing, userId);

    const { data: created, error } = await client
      .schema('chat')
      .from('conversation')
      .insert({
        school_id: schoolId,
        type: 'direct',
        direct_key: directKey,
        created_by: userId,
      })
      .select(CONVERSATION_COLUMNS)
      .single();

    // Lost a race to the unique (school_id, direct_key) index — reuse theirs.
    if (error || !created) {
      const raced = await this.findDirect(schoolId, directKey);
      if (raced) return this.summarize(raced, userId);
      this.logger.error(`Failed to create DM: ${error?.message}`);
      throw new BadRequestException('Failed to start conversation');
    }

    const { error: memberError } = await client
      .schema('chat')
      .from('conversation_member')
      .insert([
        { conversation_id: created.id, user_id: userId, role: 'owner' },
        { conversation_id: created.id, user_id: otherUserId, role: 'member' },
      ]);
    if (memberError) {
      this.logger.error(`Failed to add DM members: ${memberError.message}`);
      throw new BadRequestException('Failed to start conversation');
    }

    const summary = await this.summarize(created, userId);
    // Both sides should see the new conversation appear immediately.
    await this.realtime.publishToUsers([userId, otherUserId], {
      type: ChatEventType.Conversation,
      data: summary,
    });
    return summary;
  }

  // ── Messages ───────────────────────────────────────────────────────────────

  /** A page of a conversation's history, newest first. */
  async listMessages(
    userId: string,
    conversationId: string,
    opts: { before?: string; limit?: number } = {},
  ): Promise<ChatMessage[]> {
    await this.assertMember(userId, conversationId);
    const limit = Math.min(opts.limit ?? 30, 100);

    let query = this.supabase
      .getServiceClient()
      .schema('chat')
      .from('message')
      .select(MESSAGE_COLUMNS)
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (opts.before) query = query.lt('created_at', opts.before);

    const { data } = await query;
    return (data ?? []).map((m: MessageRow) => this.presentMessage(m));
  }

  /** Send a text message to a conversation the caller belongs to. */
  async sendMessage(
    userId: string,
    conversationId: string,
    body: string,
  ): Promise<ChatMessage> {
    const conversation = await this.assertMember(userId, conversationId);
    return this.postMessage({
      conversation,
      senderId: userId,
      type: 'text',
      body,
    });
  }

  /** Edit the caller's own message. */
  async editMessage(
    userId: string,
    messageId: string,
    body: string,
  ): Promise<ChatMessage> {
    const message = await this.loadOwnMessage(userId, messageId);
    const { data, error } = await this.supabase
      .getServiceClient()
      .schema('chat')
      .from('message')
      .update({
        body: this.cipher.encrypt(body),
        edited_at: new Date().toISOString(),
      })
      .eq('id', messageId)
      .select(MESSAGE_COLUMNS)
      .single();
    if (error || !data) throw new BadRequestException('Failed to edit message');

    const present = this.presentMessage(data);
    await this.fanOutMessage(message.conversation_id, present);
    return present;
  }

  /** Soft-delete the caller's own message. */
  async deleteMessage(userId: string, messageId: string): Promise<ChatMessage> {
    const message = await this.loadOwnMessage(userId, messageId);
    const { data, error } = await this.supabase
      .getServiceClient()
      .schema('chat')
      .from('message')
      .update({ deleted_at: new Date().toISOString(), body: null })
      .eq('id', messageId)
      .select(MESSAGE_COLUMNS)
      .single();
    if (error || !data) {
      throw new BadRequestException('Failed to delete message');
    }

    const present = this.presentMessage(data);
    await this.fanOutMessage(message.conversation_id, present);
    return present;
  }

  /** Advance the caller's read marker to now. */
  async markRead(
    userId: string,
    conversationId: string,
  ): Promise<{ ok: true; lastReadAt: string }> {
    await this.assertMember(userId, conversationId);
    const lastReadAt = new Date().toISOString();
    await this.supabase
      .getServiceClient()
      .schema('chat')
      .from('conversation_member')
      .update({ last_read_at: lastReadAt })
      .eq('conversation_id', conversationId)
      .eq('user_id', userId);

    // Let the user's own other tabs/devices clear their unread badge too.
    await this.realtime.publishToUsers([userId], {
      type: ChatEventType.Read,
      data: { conversationId, userId, lastReadAt },
    });
    return { ok: true, lastReadAt };
  }

  /** Total unread messages across all of the caller's conversations. */
  async totalUnread(userId: string): Promise<{ count: number }> {
    const client = this.supabase.getServiceClient();
    const { data: memberships } = await client
      .schema('chat')
      .from('conversation_member')
      .select('conversation_id, last_read_at')
      .eq('user_id', userId);

    const rows = (memberships ?? []) as {
      conversation_id: string;
      last_read_at: string | null;
    }[];
    if (rows.length === 0) return { count: 0 };

    const counts = await this.unreadCountsFor(userId, rows);
    let total = 0;
    for (const n of counts.values()) total += n;
    return { count: total };
  }

  async postMessage(input: {
    conversation: ConversationRow;
    senderId: string;
    type: ChatMessage['type'];
    body: string | null;
    metadata?: Record<string, unknown>;
    actionState?: ChatMessage['actionState'];
  }): Promise<ChatMessage> {
    const { conversation, senderId } = input;
    const client = this.supabase.getServiceClient();
    const now = new Date().toISOString();

    const { data, error } = await client
      .schema('chat')
      .from('message')
      .insert({
        conversation_id: conversation.id,
        school_id: conversation.school_id,
        sender_id: senderId,
        type: input.type,
        // Encrypted at rest; presentMessage decrypts on the way out.
        body: this.cipher.encrypt(input.body),
        metadata: input.metadata ?? {},
        action_state: input.actionState ?? null,
      })
      .select(MESSAGE_COLUMNS)
      .single();

    if (error || !data) {
      this.logger.error(`Failed to insert message: ${error?.message}`);
      throw new BadRequestException('Failed to send message');
    }

    await client
      .schema('chat')
      .from('conversation')
      .update({ last_message_at: now })
      .eq('id', conversation.id);

    // The sender has, by definition, seen their own message.
    await client
      .schema('chat')
      .from('conversation_member')
      .update({ last_read_at: now })
      .eq('conversation_id', conversation.id)
      .eq('user_id', senderId);

    const present = this.presentMessage(data);
    await this.fanOutMessage(conversation.id, present);
    return present;
  }

  /** Load a conversation row (for system-message posting), or throw. */
  async loadConversation(conversationId: string): Promise<ConversationRow> {
    const { data } = await this.supabase
      .getServiceClient()
      .schema('chat')
      .from('conversation')
      .select(CONVERSATION_COLUMNS)
      .eq('id', conversationId)
      .maybeSingle();
    if (!data) throw new NotFoundException('Conversation not found');
    return data;
  }

  /**
   * Ensure a direct conversation exists between two users and return its row.
   * Used by system messages (file share, class invite) that must land in the
   * sender↔recipient DM. Does not emit a Conversation event on its own — the
   * subsequent message emission already surfaces the conversation.
   */
  async ensureDirectConversationRow(
    schoolId: string,
    userA: string,
    userB: string,
  ): Promise<ConversationRow> {
    const directKey = ChatService.directKey(userA, userB);
    const existing = await this.findDirect(schoolId, directKey);
    if (existing) return existing;

    const client = this.supabase.getServiceClient();
    const { data: created, error } = await client
      .schema('chat')
      .from('conversation')
      .insert({
        school_id: schoolId,
        type: 'direct',
        direct_key: directKey,
        created_by: userA,
      })
      .select(CONVERSATION_COLUMNS)
      .single();

    if (error || !created) {
      const raced = await this.findDirect(schoolId, directKey);
      if (raced) return raced;
      throw new BadRequestException('Failed to open conversation');
    }

    await client
      .schema('chat')
      .from('conversation_member')
      .insert([
        { conversation_id: created.id, user_id: userA, role: 'owner' },
        { conversation_id: created.id, user_id: userB, role: 'member' },
      ]);

    return created;
  }

  /** Set a system message's action state and fan the change out. */
  async setActionState(
    userId: string,
    messageId: string,
    state: 'accepted' | 'dismissed',
  ): Promise<ChatMessage> {
    const { data: message } = await this.supabase
      .getServiceClient()
      .schema('chat')
      .from('message')
      .select('id, conversation_id, sender_id, action_state')
      .eq('id', messageId)
      .maybeSingle();

    if (!message) throw new NotFoundException('Message not found');

    const conversation = await this.assertMember(
      userId,
      message.conversation_id as string,
    );
    // The recipient acts on it, never the sender who created the action.
    if (message.sender_id === userId) {
      throw new ForbiddenException('You cannot act on your own request');
    }
    if (message.action_state === null) {
      throw new BadRequestException('This message has no action');
    }

    const { data, error } = await this.supabase
      .getServiceClient()
      .schema('chat')
      .from('message')
      .update({ action_state: state })
      .eq('id', messageId)
      .select(MESSAGE_COLUMNS)
      .single();
    if (error || !data) {
      throw new BadRequestException('Failed to update action');
    }

    const present = this.presentMessage(data);
    await this.realtime.publishToUsers(await this.memberIds(conversation.id), {
      type: ChatEventType.MessageAction,
      data: present,
    });
    return present;
  }

  // ── Channels (feature-flagged) ──────────────────────────────────────────────

  async createChannel(
    userId: string,
    title: string,
    memberIds: string[],
  ): Promise<ChatConversation> {
    if (!channelsEnabled()) {
      throw new ForbiddenException('Channels are not enabled');
    }
    const schoolId = await this.supabase.getUserSchoolId(userId);
    const client = this.supabase.getServiceClient();

    const { data: created, error } = await client
      .schema('chat')
      .from('conversation')
      .insert({
        school_id: schoolId,
        type: 'channel',
        title,
        created_by: userId,
      })
      .select(CONVERSATION_COLUMNS)
      .single();
    if (error || !created) {
      throw new BadRequestException('Failed to create channel');
    }

    const uniqueMembers = [...new Set([userId, ...memberIds])];
    await client
      .schema('chat')
      .from('conversation_member')
      .insert(
        uniqueMembers.map((id) => ({
          conversation_id: created.id,
          user_id: id,
          role: id === userId ? 'owner' : 'member',
        })),
      );

    const summary = await this.summarize(created, userId);
    await this.realtime.publishToUsers(uniqueMembers, {
      type: ChatEventType.Conversation,
      data: summary,
    });
    return summary;
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private async fanOutMessage(
    conversationId: string,
    message: ChatMessage,
  ): Promise<void> {
    const members = await this.memberIds(conversationId);
    await this.realtime.publishToUsers(members, {
      type: ChatEventType.Message,
      data: message,
    });
  }

  private async assertMember(
    userId: string,
    conversationId: string,
  ): Promise<ConversationRow> {
    const { data: membership } = await this.supabase
      .getServiceClient()
      .schema('chat')
      .from('conversation_member')
      .select('id')
      .eq('conversation_id', conversationId)
      .eq('user_id', userId)
      .maybeSingle();

    if (!membership) {
      throw new ForbiddenException('You are not in this conversation');
    }
    return this.loadConversation(conversationId);
  }

  private async loadOwnMessage(
    userId: string,
    messageId: string,
  ): Promise<MessageRow> {
    const { data } = await this.supabase
      .getServiceClient()
      .schema('chat')
      .from('message')
      .select(MESSAGE_COLUMNS)
      .eq('id', messageId)
      .maybeSingle();
    if (!data) throw new NotFoundException('Message not found');
    if (data.sender_id !== userId) {
      throw new ForbiddenException('You can only modify your own messages');
    }
    return data;
  }

  private async memberIds(conversationId: string): Promise<string[]> {
    const { data } = await this.supabase
      .getServiceClient()
      .schema('chat')
      .from('conversation_member')
      .select('user_id')
      .eq('conversation_id', conversationId);
    return (data ?? []).map((m: any) => m.user_id);
  }

  private async findDirect(
    schoolId: string,
    directKey: string,
  ): Promise<ConversationRow | null> {
    const { data } = await this.supabase
      .getServiceClient()
      .schema('chat')
      .from('conversation')
      .select(CONVERSATION_COLUMNS)
      .eq('school_id', schoolId)
      .eq('type', 'direct')
      .eq('direct_key', directKey)
      .maybeSingle();
    return data ?? null;
  }

  private async lastMessageFor(
    conversationId: string,
  ): Promise<ChatMessage | null> {
    const { data } = await this.supabase
      .getServiceClient()
      .schema('chat')
      .from('message')
      .select(MESSAGE_COLUMNS)
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    return data ? this.presentMessage(data) : null;
  }

  private async unreadCountsFor(
    userId: string,
    memberships: { conversation_id: string; last_read_at: string | null }[],
  ): Promise<Map<string, number>> {
    const client = this.supabase.getServiceClient();
    try {
      const { data, error } = await client
        .schema('chat')
        .rpc('unread_counts', { p_user_id: userId });
      if (error) throw error;
      const map = new Map<string, number>();
      for (const row of (data ?? []) as {
        conversation_id: string;
        unread: number | string;
      }[]) {
        map.set(row.conversation_id, Number(row.unread) || 0);
      }
      return map;
    } catch (err) {
      this.logger.warn(
        `unread_counts RPC unavailable, falling back to per-conversation counts: ${String(err)}`,
      );
      const entries = await Promise.all(
        memberships.map(
          async (m) =>
            [
              m.conversation_id,
              await this.unreadFor(m.conversation_id, userId, m.last_read_at),
            ] as const,
        ),
      );
      return new Map(entries);
    }
  }

  private async unreadFor(
    conversationId: string,
    userId: string,
    lastReadAt: string | null,
  ): Promise<number> {
    let query = this.supabase
      .getServiceClient()
      .schema('chat')
      .from('message')
      .select('id', { count: 'exact', head: true })
      .eq('conversation_id', conversationId)
      .neq('sender_id', userId)
      .is('deleted_at', null);

    if (lastReadAt) query = query.gt('created_at', lastReadAt);

    const { count } = await query;
    return count ?? 0;
  }

  /** Members (with profiles) for a set of conversations, grouped by id. */
  private async participantsFor(
    conversationIds: string[],
  ): Promise<Map<string, ChatParticipant[]>> {
    const client = this.supabase.getServiceClient();
    const { data: members } = await client
      .schema('chat')
      .from('conversation_member')
      .select('conversation_id, user_id')
      .in('conversation_id', conversationIds);

    const rows = (members ?? []) as {
      conversation_id: string;
      user_id: string;
    }[];
    const userIds = [...new Set(rows.map((m) => m.user_id))];

    const { data: profiles } = await client
      .from('user_profile')
      .select('id, first_name, last_name, avatar_url')
      .in('id', userIds);

    const profileMap = new Map(
      (profiles ?? []).map((p: any) => [
        p.id,
        {
          userId: p.id,
          firstName: p.first_name,
          lastName: p.last_name,
          avatarUrl: p.avatar_url,
        },
      ]),
    );

    const grouped = new Map<string, ChatParticipant[]>();
    for (const m of rows) {
      const participant = profileMap.get(m.user_id);
      if (!participant) continue;
      const list = grouped.get(m.conversation_id) ?? [];
      list.push(participant);
      grouped.set(m.conversation_id, list);
    }
    return grouped;
  }

  /** Build a full conversation summary for one conversation and one viewer. */
  private async summarize(
    conv: ConversationRow,
    userId: string,
  ): Promise<ChatConversation> {
    const [participantsMap, lastMessage] = await Promise.all([
      this.participantsFor([conv.id]),
      this.lastMessageFor(conv.id),
    ]);
    const { data: membership } = await this.supabase
      .getServiceClient()
      .schema('chat')
      .from('conversation_member')
      .select('last_read_at')
      .eq('conversation_id', conv.id)
      .eq('user_id', userId)
      .maybeSingle();

    const last_read_at: string | null = membership?.last_read_at ?? null;

    const unreadCount = await this.unreadFor(conv.id, userId, last_read_at);

    return this.presentConversation(
      conv,
      participantsMap.get(conv.id) ?? [],
      lastMessage,
      unreadCount,
    );
  }

  private async resolveSchool(userId: string): Promise<string | null> {
    const { data } = await this.supabase
      .getServiceClient()
      .from('user_profile')
      .select('school_id')
      .eq('id', userId)
      .maybeSingle();
    return data?.school_id ?? null;
  }

  private presentConversation(
    conv: ConversationRow,
    participants: ChatParticipant[],
    lastMessage: ChatMessage | null,
    unreadCount: number,
  ): ChatConversation {
    return {
      id: conv.id,
      type: conv.type,
      title: conv.title,
      lastMessageAt: conv.last_message_at,
      participants,
      lastMessage,
      unreadCount,
    };
  }

  private presentMessage(m: MessageRow): ChatMessage {
    return {
      id: m.id,
      conversationId: m.conversation_id,
      senderId: m.sender_id,
      type: m.type,
      body: this.cipher.decrypt(m.body),
      metadata: m.metadata ?? {},
      actionState: m.action_state,
      createdAt: m.created_at,
      editedAt: m.edited_at,
      deletedAt: m.deleted_at,
    };
  }

  /** Canonical unordered key for a direct conversation between two users. */
  static directKey(a: string, b: string): string {
    return a < b ? `${a}:${b}` : `${b}:${a}`;
  }
}
