import { describe, test, expect } from 'bun:test';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { PermissionService } from './permission.service';
import { createRoutingSupabase, expectRejection } from '@/test/mocks';
import { PERM_CACHE_PREFIX } from './permission.effective';

function makeCache() {
  const prefixes: string[] = [];
  return {
    cache: {
      get: () => Promise.resolve(null),
      set: async () => {},
      delete: async () => {},
      deleteByPrefix: (p: string) => {
        prefixes.push(p);
        return Promise.resolve();
      },
    } as any,
    prefixes,
  };
}

const ADMIN = 'admin-1';

describe('PermissionService', () => {
  test('createRole inserts a role scoped to the admin school', async () => {
    const sb = createRoutingSupabase({
      tables: {
        user_profile: { data: { school_id: 's1' }, error: null },
        school_role: {
          data: { id: 'r1', name: 'Librarian', is_system: false },
          error: null,
        },
      },
    });
    const { cache } = makeCache();
    const svc = new PermissionService(sb as any, cache);

    const role = await svc.createRole(ADMIN, { name: 'Librarian' });
    expect(role.id).toBe('r1');

    const insert = sb._calls.find(
      (c) => c.table === 'school_role' && c.op === 'insert',
    );
    expect(insert?.payload).toMatchObject({
      school_id: 's1',
      is_system: false,
    });
  });

  test('createRole surfaces a duplicate-name conflict as 400', async () => {
    const sb = createRoutingSupabase({
      tables: {
        user_profile: { data: { school_id: 's1' }, error: null },
        school_role: { data: null, error: { code: '23505' } },
      },
    });
    const { cache } = makeCache();
    const svc = new PermissionService(sb as any, cache);

    expect(
      await expectRejection(svc.createRole(ADMIN, { name: 'Teacher' })),
    ).toBeInstanceOf(BadRequestException);
  });

  test('system roles cannot be modified', async () => {
    const sb = createRoutingSupabase({
      tables: {
        user_profile: { data: { school_id: 's1' }, error: null },
        school_role: {
          data: { id: 'r1', school_id: 's1', is_system: true, name: 'admin' },
          error: null,
        },
      },
    });
    const { cache } = makeCache();
    const svc = new PermissionService(sb as any, cache);

    expect(
      await expectRejection(svc.updateRole(ADMIN, 'r1', { name: 'x' })),
    ).toBeInstanceOf(ForbiddenException);
  });

  test('system roles expose their code-defined default permissions', async () => {
    const sb = createRoutingSupabase({
      tables: {
        user_profile: { data: { school_id: 's1' }, error: null },
        school_role: {
          data: { id: 'r1', school_id: 's1', is_system: true, name: 'teacher' },
          error: null,
        },
      },
    });
    const { cache } = makeCache();
    const svc = new PermissionService(sb as any, cache);

    const permissions = await svc.getRolePermissions(ADMIN, 'r1');
    expect(permissions).toContain('class:create');
    expect(permissions).toContain('student:read');
    expect(permissions).not.toContain('class:update');
  });

  test('setRolePermissions rejects unknown keys', async () => {
    const sb = createRoutingSupabase({
      tables: {
        user_profile: { data: { school_id: 's1' }, error: null },
        school_role: {
          data: {
            id: 'r1',
            school_id: 's1',
            is_system: false,
            name: 'Librarian',
          },
          error: null,
        },
      },
    });
    const { cache } = makeCache();
    const svc = new PermissionService(sb as any, cache);

    expect(
      await expectRejection(
        svc.setRolePermissions(ADMIN, 'r1', ['bogus:read']),
      ),
    ).toBeInstanceOf(BadRequestException);
  });

  test('setRolePermissions replaces grants and invalidates the cache', async () => {
    const sb = createRoutingSupabase({
      tables: {
        user_profile: { data: { school_id: 's1' }, error: null },
        school_role: {
          data: {
            id: 'r1',
            school_id: 's1',
            is_system: false,
            name: 'Librarian',
          },
          error: null,
        },
        permission_catalog: { data: [{ id: 'p1' }], error: null },
        school_role_permission: { data: null, error: null },
      },
    });
    const { cache, prefixes } = makeCache();
    const svc = new PermissionService(sb as any, cache);

    const result = await svc.setRolePermissions(ADMIN, 'r1', ['student:read']);
    expect(result.keys).toEqual(['student:read']);

    // Old grants cleared, new grants inserted.
    expect(
      sb._calls.some(
        (c) => c.table === 'school_role_permission' && c.op === 'delete',
      ),
    ).toBe(true);
    expect(
      sb._calls.some(
        (c) => c.table === 'school_role_permission' && c.op === 'insert',
      ),
    ).toBe(true);
    expect(prefixes).toContain(PERM_CACHE_PREFIX);
  });

  test('getMyPermissions returns empty for a user with no active school', async () => {
    const sb = createRoutingSupabase({
      tables: { user_profile: { data: { school_id: null }, error: null } },
    });
    const { cache } = makeCache();
    const svc = new PermissionService(sb as any, cache);

    const result = await svc.getMyPermissions('u1');
    expect(result).toEqual({
      schoolId: null,
      role: null,
      isAdmin: false,
      permissions: [],
    });
  });

  test('getMyPermissions reports admin with the full catalog', async () => {
    const sb = createRoutingSupabase({
      tables: {
        user_profile: { data: { school_id: 's1' }, error: null },
        school_management: { data: { id: 'm1', role: 'admin' }, error: null },
      },
    });
    const { cache } = makeCache();
    const svc = new PermissionService(sb as any, cache);

    const result = await svc.getMyPermissions('u1');
    expect(result.isAdmin).toBe(true);
    expect(result.role).toBe('admin');
    expect(result.permissions).toContain('student:delete');
  });

  test('getMyPermissions serves a cached effective set without re-querying', async () => {
    const sb = createRoutingSupabase({
      tables: {
        user_profile: { data: { school_id: 's1' }, error: null },
        // A cache hit must not reach the membership/role tables.
        school_management: () => {
          throw new Error('should not query on cache hit');
        },
      },
    });
    const cache = {
      get: () =>
        Promise.resolve({
          member: true,
          role: 'teacher',
          keys: ['student:read'],
        }),
      set: async () => {},
      delete: async () => {},
      deleteByPrefix: async () => {},
    } as any;
    const svc = new PermissionService(sb as any, cache);

    const result = await svc.getMyPermissions('u1');
    expect(result.permissions).toEqual(['student:read']);
    expect(result.role).toBe('teacher');
    expect(result.isAdmin).toBe(false);
  });

  test('assignRoleToMember rejects a membership from another school', async () => {
    const sb = createRoutingSupabase({
      tables: {
        user_profile: { data: { school_id: 's1' }, error: null },
        school_management: { data: { id: 'm1', school_id: 's2' }, error: null },
      },
    });
    const { cache } = makeCache();
    const svc = new PermissionService(sb as any, cache);

    expect(
      await expectRejection(svc.assignRoleToMember(ADMIN, 'm1', 'r1')),
    ).toBeInstanceOf(ForbiddenException);
  });

  test('changeMemberRole allows clearing a member default role to null', async () => {
    const sb = createRoutingSupabase({
      tables: {
        user_profile: (call) =>
          call.op === 'select'
            ? { data: { school_id: 's1' }, error: null }
            : { data: null, error: null },
        school: { data: { owner_id: 'owner-user' }, error: null },
        school_management: (call) =>
          call.op === 'select'
            ? {
                data: { id: 'm1', user_id: 'u2', school_id: 's1' },
                error: null,
              }
            : { data: null, error: null },
      },
    });
    const { cache, prefixes } = makeCache();
    const svc = new PermissionService(sb as any, cache);

    const result = await svc.changeMemberRole(ADMIN, 'm1', null);
    expect(result).toEqual({ role: null });
    expect(prefixes).toContain(PERM_CACHE_PREFIX);

    const mgmtUpdate = sb._calls.find(
      (c) => c.table === 'school_management' && c.op === 'update',
    );
    expect(mgmtUpdate?.payload.role).toBeNull();
  });

  test('changeMemberRole rejects changing the school owner role', async () => {
    const sb = createRoutingSupabase({
      tables: {
        user_profile: { data: { school_id: 's1' }, error: null },
        school: { data: { owner_id: 'u2' }, error: null },
        school_management: {
          data: { id: 'm1', user_id: 'u2', school_id: 's1' },
          error: null,
        },
      },
    });
    const { cache } = makeCache();
    const svc = new PermissionService(sb as any, cache);

    expect(
      await expectRejection(svc.changeMemberRole(ADMIN, 'm1', 'teacher')),
    ).toBeInstanceOf(ForbiddenException);
  });

  test('changeMemberRole gives actionable error when nullable migration is missing (code 23502)', async () => {
    const sb = createRoutingSupabase({
      tables: {
        user_profile: { data: { school_id: 's1' }, error: null },
        school: { data: { owner_id: 'owner-user' }, error: null },
        school_management: (call) =>
          call.op === 'select'
            ? {
                data: { id: 'm1', user_id: 'u2', school_id: 's1' },
                error: null,
              }
            : {
                data: null,
                error: { code: '23502', message: 'not-null violation' },
              },
      },
    });
    const { cache } = makeCache();
    const svc = new PermissionService(sb as any, cache);

    const err = await expectRejection(svc.changeMemberRole(ADMIN, 'm1', null));
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).message).toBe(
      'The database must allow members without a default role. Apply the nullable membership role migration first.',
    );
  });
});
