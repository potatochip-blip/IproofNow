import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { NextRequest } from 'next/server';
import { GET as listNotifications } from '@/app/api/notifications/route';
import { PATCH as patchNotification } from '@/app/api/notifications/[notificationId]/route';
import { POST as readAll } from '@/app/api/notifications/read-all/route';
import { POST as sealProof } from '@/app/api/proofs/[proofId]/seal/route';
import {
  buildJsonRequest,
  createTestNotification,
  createTestProof,
  createTestUser,
  db,
  loginAs,
  truncateAll,
} from './helpers';
import { resetCookieJar } from './cookie-jar';

beforeEach(async () => {
  await truncateAll();
  resetCookieJar();
});

afterAll(async () => {
  await db().$disconnect();
});

describe('GET /api/notifications', () => {
  it('returns only caller notifications, newest first, with unreadCount', async () => {
    const { user } = await createTestUser();
    await loginAs(user.id);

    await createTestNotification(user.id, { title: 'old', readAt: new Date() });
    await createTestNotification(user.id, { title: 'newer' });

    // Other user's notification — must not appear.
    const other = await createTestUser({ email: 'other@iproofnow.dev' });
    await createTestNotification(other.user.id, { title: 'theirs' });

    const res = await listNotifications(
      new Request('http://localhost/api/notifications') as NextRequest
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.notifications).toHaveLength(2);
    expect(body.notifications[0].title).toBe('newer');
    expect(body.unreadCount).toBe(1);
  });

  it('?unreadOnly=true filters to unread', async () => {
    const { user } = await createTestUser();
    await loginAs(user.id);
    await createTestNotification(user.id, { title: 'read', readAt: new Date() });
    await createTestNotification(user.id, { title: 'unread' });

    const res = await listNotifications(
      new Request('http://localhost/api/notifications?unreadOnly=true') as NextRequest
    );
    const body = await res.json();
    expect(body.notifications).toHaveLength(1);
    expect(body.notifications[0].title).toBe('unread');
  });

  it('401 without session', async () => {
    const res = await listNotifications(
      new Request('http://localhost/api/notifications') as NextRequest
    );
    expect(res.status).toBe(401);
  });
});

describe('PATCH /api/notifications/[notificationId]', () => {
  it('toggles readAt on own notification', async () => {
    const { user } = await createTestUser();
    await loginAs(user.id);
    const n = await createTestNotification(user.id);

    const read = await patchNotification(
      buildJsonRequest(
        `http://localhost/api/notifications/${n.id}`,
        'PATCH',
        { read: true }
      ) as NextRequest,
      { params: { notificationId: n.id } }
    );
    expect(read.status).toBe(200);
    const readBody = await read.json();
    expect(readBody.readAt).toBeTruthy();

    const unread = await patchNotification(
      buildJsonRequest(
        `http://localhost/api/notifications/${n.id}`,
        'PATCH',
        { read: false }
      ) as NextRequest,
      { params: { notificationId: n.id } }
    );
    const unreadBody = await unread.json();
    expect(unreadBody.readAt).toBeNull();
  });

  it('403 on foreign notification', async () => {
    const owner = await createTestUser();
    const n = await createTestNotification(owner.user.id);

    const other = await createTestUser({ email: 'other@iproofnow.dev' });
    await loginAs(other.user.id);

    const res = await patchNotification(
      buildJsonRequest(
        `http://localhost/api/notifications/${n.id}`,
        'PATCH',
        { read: true }
      ) as NextRequest,
      { params: { notificationId: n.id } }
    );
    expect(res.status).toBe(403);
  });

  it('404 on missing notification', async () => {
    const { user } = await createTestUser();
    await loginAs(user.id);

    const res = await patchNotification(
      buildJsonRequest(
        'http://localhost/api/notifications/missing',
        'PATCH',
        { read: true }
      ) as NextRequest,
      { params: { notificationId: 'missing' } }
    );
    expect(res.status).toBe(404);
  });
});

describe('POST /api/notifications/read-all', () => {
  it('marks all unread of caller and returns updated count', async () => {
    const { user } = await createTestUser();
    await loginAs(user.id);
    await createTestNotification(user.id, { title: '1' });
    await createTestNotification(user.id, { title: '2' });
    await createTestNotification(user.id, { title: '3', readAt: new Date() });

    // Foreign user's unread — must not be touched.
    const other = await createTestUser({ email: 'other@iproofnow.dev' });
    await createTestNotification(other.user.id, { title: 'theirs-unread' });

    const res = await readAll();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.updated).toBe(2);

    const stillUnread = await db().notification.count({
      where: { userId: user.id, readAt: null },
    });
    expect(stillUnread).toBe(0);

    const othersUnread = await db().notification.count({
      where: { userId: other.user.id, readAt: null },
    });
    expect(othersUnread).toBe(1);
  });
});

describe('seal → proof_sealed notification', () => {
  it('creates a notification for the owner when a proof is sealed', async () => {
    const { user } = await createTestUser();
    await loginAs(user.id);
    const proof = await createTestProof(user.id, { title: 'Ready' });
    await db().proofFile.create({
      data: {
        proofId: proof.id,
        originalName: 'x.txt',
        mimeType: 'text/plain',
        size: 1,
        storagePath: `proofs/${proof.id}/x`,
      },
    });
    await db().proofAttestation.create({
      data: {
        proofId: proof.id,
        attestationName: 'A',
        attestationLocation: 'B',
        attestationText: 'C',
      },
    });

    const res = await sealProof(
      new Request(`http://localhost/api/proofs/${proof.id}/seal`, {
        method: 'POST',
      }) as NextRequest,
      { params: { proofId: proof.id } }
    );
    expect(res.status).toBe(200);

    const notif = await db().notification.findFirst({
      where: { userId: user.id, type: 'proof_sealed' },
    });
    expect(notif).toBeTruthy();
    expect(notif?.href).toBe(`/proofs/${proof.id}`);
    expect(notif?.title).toBe('Proof sealed');
  });
});
